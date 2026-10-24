import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { desktopRestartBarrier } from '../lib/desktop-restart-guard.js'
import { windowsRestartLaunch } from '../lib/windows-restart-worker.js'
import { scheduleAsarSwapRestart, chooseHelperRunner } from '../lib/desktop.js'
import { patchDesktopBootstrap } from '../lib/desktop-bootstrap-compat.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('restart helper skips desktop node.cmd shims and selects a native executable', () => {
  assert.equal(chooseHelperRunner(['C:/desktop/node.cmd','C:/Program Files/nodejs/node.exe'],'win32',()=>true),'C:/Program Files/nodejs/node.exe')
  assert.equal(chooseHelperRunner(['C:/desktop/node.cmd'],'win32',()=>true),'')
  assert.equal(chooseHelperRunner(['/usr/bin/node'],'linux',()=>true),'/usr/bin/node')
})

test('unpacked installed Office assets keep their packaged path; development stays unchanged', () => {
  const original="process.env.DSH_DESKTOP_OFFICE_RESOURCES = archive\n      ? join(resources, 'office-runtime')\n      : join(resources, '..', '.build', 'office-runtime')"
  const patched=patchDesktopBootstrap(original)
  assert.equal(patched.changed,true)
  assert.equal(patchDesktopBootstrap(patched.text).changed,false)
  const body=patched.text.replace(/^import[^\n]+\n/,'')+'; return process.env.DSH_DESKTOP_OFFICE_RESOURCES;'
  const run=new Function('archive','resources','join','dshPurgeAssetExists','process',body)
  const resources=path.join(os.tmpdir(),'installed-resources')
  for(const [archive,assets,expected] of [[true,false,path.join(resources,'office-runtime')],[undefined,true,path.join(resources,'office-runtime')],[undefined,false,path.join(resources,'..','.build','office-runtime')]]) {
    assert.equal(run(archive,resources,path.join,()=>assets,{env:{}}),expected)
  }
  assert.equal(patchDesktopBootstrap('unrelated bootstrap').changed,false)
})

test('desktop confirmation is required; elapsed time never overrides its journal', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-restart-guard-'))
  const file=path.join(home,'profiles','web','.generations-pre-migration.json')
  try {
    assert.equal(desktopRestartBarrier(home).ready,true)
    fs.mkdirSync(path.dirname(file),{recursive:true})
    for(const phase of ['snapshotting','awaiting-boot','rolling-back','rollback-cleanup']) {
      fs.writeFileSync(file,JSON.stringify({phase}))
      fs.utimesSync(file,new Date(0),new Date(0))
      assert.equal(desktopRestartBarrier(home).ready,false,phase)
    }
    fs.writeFileSync(file,'broken json')
    assert.equal(desktopRestartBarrier(home).ready,false)
    fs.writeFileSync(file,JSON.stringify({phase:'confirmed'}))
    assert.equal(desktopRestartBarrier(home).ready,true)
    fs.unlinkSync(file)
    assert.equal(desktopRestartBarrier(home).ready,true)
  } finally { fs.rmSync(home,{recursive:true,force:true}) }
})

test('pending migration rejects restart before a worker can launch', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-restart-block-'))
  const previous=process.env.DSH_HOME
  try {
    const dir=path.join(home,'profiles','web');fs.mkdirSync(dir,{recursive:true})
    fs.writeFileSync(path.join(dir,'.generations-pre-migration.json'),JSON.stringify({phase:'awaiting-boot'}))
    process.env.DSH_HOME=home
    assert.throws(()=>scheduleAsarSwapRestart({exe:'not-used.exe',asar:'not-used.asar'}),/60 秒/)
    assert.equal(fs.readdirSync(home).join(','),'profiles')
  } finally {
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
    fs.rmSync(home,{recursive:true,force:true})
  }
})

test('worker broker quotes Windows paths without a shell', () => {
  const spec=windowsRestartLaunch("C:\\user's folder\\worker.ps1",['-WaitPid','123','-AsarPath',"C:\\user's folder\\app.asar",'-ExePath','C:\\中文 & space\\DSH Desktop.exe'],{SystemRoot:'C:\\Windows'})
  assert.equal(spec.executable,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  const command=Buffer.from(spec.args.at(-1),'base64').toString('utf16le')
  assert(command.includes('-WindowStyle Hidden -PassThru'))
  assert(command.includes("user''s folder"))
  assert(command.includes('"C:\\中文 & space\\DSH Desktop.exe"'))
})

test('worker launch failure reports an error without exiting Harness', {skip:process.platform!=='win32'}, () => {
  const oldRoot=process.env.SystemRoot, oldHome=process.env.DSH_HOME
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-restart-failure-'))
  try {
    process.env.SystemRoot=path.join(root,'missing-windows')
    process.env.DSH_HOME=path.join(root,'home')
    assert.throws(()=>scheduleAsarSwapRestart({exe:path.join(root,'DSH Desktop.exe'),asar:path.join(root,'resources','app.asar'),exit:true}),/ENOENT/)
  } finally {
    if(oldRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=oldRoot
    if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome
    fs.rmSync(root,{recursive:true,force:true})
  }
})

test('Windows worker survives parent stop, swaps an isolated archive and relaunches', {skip:process.platform!=='win32',timeout:30000}, async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh restart flow '))
  const exe=path.join(root,'DSH Desktop.exe'),hook=path.join(root,'hook.cjs'),entry=path.join(root,'host.mjs')
  const asar=path.join(root,'resources','app.asar'),result=path.join(root,'relaunched.txt')
  let child
  try {
    fs.mkdirSync(path.join(root,'resources','app'),{recursive:true})
    fs.copyFileSync(process.execPath,exe)
    fs.writeFileSync(asar,'isolated archive fixture')
    fs.writeFileSync(hook,`if(process.argv.length<2){require('fs').writeFileSync(${JSON.stringify(result)},'relaunched');process.exit(0);}`)
    const desktop=pathToFileURL(path.resolve(import.meta.dirname,'../lib/desktop.js')).href
    fs.writeFileSync(entry,`import {scheduleAsarSwapRestart} from ${JSON.stringify(desktop)};scheduleAsarSwapRestart({exe:process.execPath,asar:${JSON.stringify(asar)},waitPid:process.pid,exit:true});setInterval(()=>{},1000);`)
    const log=fs.openSync(path.join(root,'host.log'),'w')
    try {
      child=spawn(exe,[entry],{env:{...process.env,NODE_OPTIONS:`--require="${hook.replaceAll('\\','/')}"`,DSH_HOME:path.join(root,'home')},stdio:['ignore',log,log],windowsHide:true})
    } finally { fs.closeSync(log) }
    const deadline=Date.now()+20000
    while(!fs.existsSync(result)&&Date.now()<deadline)await delay(100)
    assert(fs.existsSync(result),fs.readFileSync(path.join(root,'host.log'),'utf8'))
    assert.equal(fs.existsSync(asar),false)
    assert.equal(fs.readFileSync(asar+'.bak','utf8'),'isolated archive fixture')
    assert.equal(fs.readFileSync(result,'utf8'),'relaunched')
    await delay(200)
  } finally {
    if(child&&child.exitCode===null)child.kill()
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
})

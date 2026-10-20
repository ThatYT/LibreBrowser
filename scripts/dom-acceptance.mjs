// Real client Chromium -> Go account shell -> separate renderer -> per-user server Chromium.
// Input is ephemeral test configuration on stdin. Never use real account credentials here.
import { readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const config=JSON.parse(readFileSync(0,'utf8'));
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',headless:true,pipe:true,
  args:['--disable-dev-shm-usage','--no-first-run'],defaultViewport:{width:1920,height:1080}});
const results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function viewer(page){
  await page.waitForFunction(()=>document.querySelector('#stream')?.src.includes('/join'),{timeout:90000});
  let frame;
  for(let n=0;n<180;n++){
    frame=page.frames().find(f=>f.url().startsWith(config.rendererOrigin)&&!f.url().includes('/join'));
    if(frame&&await frame.$('#urlbar input'))return frame;
    await sleep(500);
  }
  throw Error('DOM viewer did not load');
}
async function navigate(frame,url){
  await frame.waitForSelector('#urlbar input:not([disabled])',{timeout:20000});
  const input=await frame.$('#urlbar input');await input.click();await input.evaluate(element=>element.select());await input.press('Backspace');await input.type(url);console.log('navigate field',await input.evaluate(e=>e.value));await input.press('Enter');
}
async function mirror(frame,selector){
  for(let n=0;n<120;n++){
    for(const child of frame.childFrames()){
      try {
        if(await child.$(selector)) {
          await sleep(700); // Initial viewport negotiation replaces the first replay iframe.
          const current=frame.childFrames();
          for(const candidate of current) if(await candidate.$(selector)) return candidate;
        }
      } catch { /* rrweb can replace a document between CDP lookup and adoption. Retry the current frame. */ }
    }
    await sleep(250);
  }
  console.error('viewer state',await frame.evaluate(()=>({text:document.body.innerText.slice(0,1000),frames:[...document.querySelectorAll('iframe')].map(f=>f.outerHTML.slice(0,600)),host:document.querySelector('#mirror-host')?.innerHTML.slice(0,800)})));
  for(const child of frame.childFrames()) console.error('child state',child.url(),await child.evaluate(()=>document.body?.innerText.slice(0,800)).catch(()=>''));
  throw Error('Local DOM missing '+selector);
}
async function waitLocal(frame,selector,value){
  for(let n=0;n<160;n++){
    for(const child of frame.childFrames()){
      try{if(await child.evaluate((s,v)=>document.querySelector(s)?.textContent===v,selector,value))return child;}catch{}
    }
    await sleep(125);
  }
  console.error('confirmation failed',selector,value,await frame.evaluate(()=>document.body.innerText.slice(0,1000)));
  for(const child of frame.childFrames())console.error('mirror state',await child.evaluate(()=>({text:document.body.innerText.slice(0,800),input:document.querySelector('#fixture-input')?.value})).catch(()=>null));
  throw Error('Authoritative DOM did not confirm '+selector);
}
async function start(user){
  const context=await browser.createBrowserContext();const page=await context.newPage();await page.bringToFront();
  page.on('pageerror',error=>console.error('client error:',error.message));
  page.on('console',message=>{if(message.type()==='error'&&!/Blocked (script execution|autofocusing)|status of (401|503)/.test(message.text()))console.error('console:',message.text().slice(0,300))});
  console.log('opening',user.username);
  await page.goto(config.origin,{waitUntil:'networkidle0'});
  await page.type('[name=username]',user.username);await page.type('[name=password]',config.password);
  await page.click('#login-form button[type=submit]');
  const frame=await viewer(page);console.log('viewer ready',user.username);
  await navigate(frame,'file:///profile/chromium/librebrowser-fixture.html');
  await frame.waitForSelector('#mirror-host[data-input-ready="true"]',{timeout:20000});
  let local=await mirror(frame,'#fixture-input');console.log('fixture ready',user.username);
  await page.screenshot({path:'/artifacts/dom-fixture.png'});
  local=await waitLocal(frame,'#remote-marker','executed on server');
  const remoteScriptRanLocally=await local.evaluate(()=>Boolean(window.__serverScriptExecuted));
  if(remoteScriptRanLocally)throw Error('Visited script executed inside the client mirror');
  await local.click('#fixture-input');
  const plain=user.value.replace(/中文$/, '');
  await local.type('#fixture-input',plain);
  local=await waitLocal(frame,'#confirmed',plain);
  const client=await page.createCDPSession();
  await client.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});
  await client.send('Input.insertText',{text:'中文'});
  await client.detach();
  console.log('typed and composed',user.username);
  local=await waitLocal(frame,'#confirmed',user.value);
  await local.click('#save');console.log('saved',user.username);
  local=await waitLocal(frame,'#persisted',user.value);
  writeFileSync('/tmp/dom-upload.txt','LibreBrowser DOM upload');
  const fileChooser=page.waitForFileChooser({timeout:20000});
  await local.click('#upload');
  await (await fileChooser).accept(['/tmp/dom-upload.txt']);
  local=await waitLocal(frame,'#filename','dom-upload.txt');
  await local.click('#download-file');
  await frame.waitForSelector('.download-save',{timeout:20000});
  const download=await frame.$eval('.download-save',link=>link.getAttribute('href'));
  const downloaded=await frame.evaluate(async href=>{const r=await fetch(href);if(!r.ok)throw Error('download failed');return r.text()},download);
  if(downloaded!=='LibreBrowser DOM download')throw Error('Downloaded bytes differ');
  const originSeparation=await frame.evaluate(()=>{try{parent.document.querySelector('#login-form');return false;}catch{return true;}});
  if(!originSeparation)throw Error('Renderer can access account DOM');
  results.push({user:user.username,localDOM:true,serverConfirmedTyping:true,chineseComposition:true,upload:true,download:true,serverScriptStayedRemote:true,separateOrigin:true});
  return {context,page,frame,local,user};
}
try{
  const first=await start(config.users[0]);
  const second=await start(config.users[1]);
  await first.page.bringToFront();await first.page.click('#stop-browser');
  await first.page.waitForFunction(()=>document.querySelector('#browser-message')?.textContent.includes('Browser stopped'),{timeout:60000});
  await second.page.bringToFront();second.local=await mirror(second.frame,'#fixture-input');await second.local.click('#fixture-input');await (await second.local.$('#fixture-input')).press('End');await second.local.type('#fixture-input','-still-running');
  await waitLocal(second.frame,'#confirmed',second.user.value+'-still-running');
  results.push({stoppingFirstPreservedSecond:true});
  await first.page.bringToFront();await first.page.click('#reconnect');
  const resumed=await viewer(first.page);
  await navigate(resumed,'file:///profile/chromium/librebrowser-fixture.html');
  const local=await mirror(resumed,'#persisted');
  await waitLocal(resumed,'#persisted',first.user.value);
  results.push({profileSurvivedContainerRemoval:true});
  await second.page.bringToFront();
  await second.frame.click('#new-tab');
  await second.frame.waitForFunction(()=>document.querySelectorAll('.browser-tab').length===2,{timeout:10000});
  await sleep(700);
  await navigate(second.frame,'https://www.google.com/?hl=en');
  await mirror(second.frame,'textarea[name=q],input[name=q]');
  results.push({googleHomeThroughControlledEgress:true});
  await second.page.screenshot({path:'/artifacts/google-dom.png'});
  for(const session of [first,second]){
    await session.page.bringToFront();await session.page.click('#stop-browser');
    await session.page.waitForFunction(()=>document.querySelector('#browser-message')?.textContent.includes('Browser stopped'),{timeout:60000});
  }
  console.log(JSON.stringify({checks:results}));
}finally{await browser.close();}

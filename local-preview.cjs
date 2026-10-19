const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const root = path.join(__dirname, 'build');
const state = path.join(__dirname, '.local-preview.json');
const log = path.join(__dirname, 'local-preview.log');
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm','.xml':'application/xml','.txt':'text/plain; charset=utf-8'};
function readState(){try{return JSON.parse(fs.readFileSync(state,'utf8'));}catch{return null;}}
function probe(port){return new Promise(resolve=>{const r=http.get(`http://127.0.0.1:${port}/__local_preview_health`,res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>resolve(b===__dirname));});r.on('error',()=>resolve(false));r.setTimeout(1000,()=>{r.destroy();resolve(false);});});}
async function main(){
const mode = process.argv[2] || 'start';
if(mode==='server'){
 const server=http.createServer((req,res)=>{
  let url;try{url=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);res.end();return;}
  if(url==='/__local_preview_health'){res.end(__dirname);return;}
  const target=path.resolve(root,'.'+url);
  if(target!==root&&!target.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  let file=[target,target+'.html',path.join(target,'index.html')].find(f=>{try{return fs.statSync(f).isFile();}catch{return false;}});
  let code=200;if(!file){file=path.join(root,'404.html');code=404;}
  if(!fs.existsSync(file)){res.writeHead(404);res.end('Not found');return;}
  res.writeHead(code,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});
  if(req.method==='HEAD'){res.end();return;}fs.createReadStream(file).pipe(res);
 });
 let port=Number(process.argv[3])||3000;
 server.on('error',e=>{if(e.code==='EADDRINUSE'&&port<3020){port++;server.listen(port,'127.0.0.1');}else{console.error(e);process.exit(1);}});
 server.on('listening',()=>{fs.writeFileSync(state,JSON.stringify({pid:process.pid,port}));console.log(`Local docs: http://127.0.0.1:${port}/docs`);});
 server.listen(port,'127.0.0.1');return;
}
const old=readState();
if(mode==='stop'){
 if(old&&await probe(old.port)){process.kill(old.pid,'SIGTERM');console.log('文档站已停止。');}else console.log('文档站当前未运行。');
 return;
}
if(old&&await probe(old.port)){console.log(`http://127.0.0.1:${old.port}/docs`);return;}
if(!fs.existsSync(path.join(root,'index.html')))throw new Error('Missing build/index.html');
const fd=fs.openSync(log,'a');
const child=spawn(process.execPath,[__filename,'server'],{cwd:__dirname,detached:true,stdio:['ignore',fd,fd]});child.unref();fs.closeSync(fd);
for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));const s=readState();if(s&&await probe(s.port)){console.log(`http://127.0.0.1:${s.port}/docs`);return;}}
throw new Error('启动失败，请查看 local-preview.log');
}
main().catch(e=>{console.error(e);process.exitCode=1;});

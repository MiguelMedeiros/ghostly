// Isolated NIP-46 fixture. Both remote-signer and user keys are disposable RAM-only
// keys. No existing account, public relay, filesystem secret or Nostr post is used.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44';

export async function startTestBunker(port = 0) {
  const signerKey = generateSecretKey(), userKey = generateSecretKey();
  const signerPub = getPublicKey(signerKey), userPub = getPublicKey(userKey);
  const subscriptions = new Map(); const methods = []; const sessions = new Set();
  const server = createServer((req,res) => {
    if(req.url==='/avatar') { res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','image/png');res.end(readFileSync(new URL('../../../../src-tauri/icons/32x32.png',import.meta.url)));return; }
    res.setHeader('Content-Type','text/html; charset=utf-8'); res.setHeader('Cache-Control','no-store');
    res.end(`<html><body><h1>Ghostly isolated NIP-46 test signer</h1><p>Disposable test identity. Not a real user account. Nothing is published to public relays.</p><label>Test bunker connection<input aria-label="Test bunker connection" style="width:95%" readonly value="${bunker.replaceAll('&','&amp;')}"></label><p>Test user public key: <code>${userPub}</code></p><p>Methods: ${methods.join(', ')}</p></body></html>`);
  });
  const wss = new WebSocketServer({ server, maxPayload: 16384 });
  function publish(event) {
    for (const [socket, subs] of subscriptions) for (const [id,f] of subs) {
      if (f.kinds && !f.kinds.includes(event.kind)) continue;
      if (f.authors && !f.authors.includes(event.pubkey)) continue;
      if (f['#p'] && !event.tags.some(t=>t[0]==='p' && f['#p'].includes(t[1]))) continue;
      socket.send(JSON.stringify(['EVENT',id,event]));
    }
  }
  wss.on('connection',socket=>{
    const subs=new Map(); subscriptions.set(socket,subs);
    socket.on('close',()=>subscriptions.delete(socket));
    socket.on('message',raw=>{
      try {
        const [op,id,value]=JSON.parse(raw.toString());
        if(op==='REQ') { subs.set(id,value); if(value.kinds?.includes(0) && value.authors?.includes(userPub)) socket.send(JSON.stringify(['EVENT',id,finalizeEvent({kind:0,tags:[],created_at:Math.floor(Date.now()/1000),content:JSON.stringify({name:'Ghostly test profile'})},userKey)])); socket.send(JSON.stringify(['EOSE',id])); return; }
        if(op==='CLOSE') { subs.delete(id); return; }
        if(op!=='EVENT') return;
        const event=id;
        if(!verifyEvent(event)) return;
        socket.send(JSON.stringify(['OK',event.id,true,''])); publish(event);
        if(event.kind!==24133 || !event.tags.some(t=>t[0]==='p'&&t[1]===signerPub)) return;
        const ck=getConversationKey(signerKey,event.pubkey), request=JSON.parse(decrypt(event.content,ck));
        let result, error;
        methods.push(request.method);
        if(request.method==='connect' && request.params[0]===signerPub && request.params[1]==='isolated-test-only' && request.params[2]==='sign_event:30078') { sessions.add(event.pubkey); result='ack'; }
        else if(!sessions.has(event.pubkey)) error='Not authorized';
        else if(request.method==='get_public_key') result=userPub;
        else if(request.method==='sign_event') {
          const template=JSON.parse(request.params[0]);
          if(template.kind!==30078 || !(template.content.startsWith('["ghostly-peer-proof",1,') || template.content.startsWith('Ghostly identity proof v1: '))) error='Only Ghostly proof fixtures are allowed';
          else result=JSON.stringify(finalizeEvent(template,userKey));
        } else error='Unsupported method';
        publish(finalizeEvent({kind:24133,created_at:Math.floor(Date.now()/1000),tags:[['p',event.pubkey]],content:encrypt(JSON.stringify({id:request.id,result,error}),ck)},signerKey));
      } catch { /* Reject malformed fixture traffic without logging payloads. */ }
    });
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const address=server.address();
  const bunker=`bunker://${signerPub}?relay=${encodeURIComponent(`ws://127.0.0.1:${address.port}`)}&secret=isolated-test-only`;
  return { bunker, userPub, signerPub, methods, port: address.port,
    async close(){ for(const s of wss.clients)s.terminate(); await new Promise(r=>wss.close(r)); await new Promise(r=>server.close(r)); signerKey.fill(0);userKey.fill(0); } };
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const fixture=await startTestBunker(Number(process.argv[2]||5188));
  console.log(`Isolated test signer UI: http://127.0.0.1:${fixture.port}/ (no real identity)`);
  process.on('SIGINT',()=>void fixture.close().then(()=>process.exit(0)));
}

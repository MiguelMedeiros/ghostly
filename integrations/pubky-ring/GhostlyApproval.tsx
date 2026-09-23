import {subscribeRingRequests} from './ringInput';
import React, {useEffect, useRef, useState} from 'react';
import {Modal, View, Text, Pressable, ScrollView, StyleSheet} from 'react-native';
import {useDispatch, useSelector} from 'react-redux';
import {parseRingLink,type RingRequest} from './ringLink';
import {getAllPubkys} from '../store/selectors/pubkySelectors';
import {createNewPubky, getPubkySecretKey} from '../utils/pubky';
import {inspectRingStatement, ringClaims, ringAuthorization, ringSend, ringReceive} from './pubkyRing';
export default function GhostlyApproval():React.JSX.Element {
 const keys=useSelector(getAllPubkys);const dispatch=useDispatch();
 const [visible,setVisible]=useState(false),[message,setMessage]=useState(''),[selected,setSelected]=useState(''),[statement,setStatement]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false);
 const request=useRef<RingRequest|null>(null),controller=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 function cleanup(){controller.current?.abort();request.current?.secret.fill(0);request.current=null;if(timer.current)clearTimeout(timer.current);}
 useEffect(()=>{
  const unsubscribe=subscribeRingRequests(url=>{
   if(request.current)return; // Never replace an in-progress consent with another link.
   setSelected('');setStatement('');setDone(false);setBusy(false);setVisible(true);
   try{const r=parseRingLink(url);request.current=r;controller.current=new AbortController();setMessage('Choose an identity. Only its public key is sent to Ghostly before approval.');timer.current=setTimeout(()=>{cleanup();setBusy(false);setMessage('Request expired. Ask Ghostly for a new QR code.');},Math.max(1,r.expires*1000-Date.now()));}
   catch(error){setMessage(error instanceof Error?error.message:'Invalid request. Ask Ghostly for a new QR code.');}
  });
  return()=>{unsubscribe();cleanup();};
 },[]);
 async function choose(key:string){
  const r=request.current,c=controller.current;if(!r||!c||busy||selected)return;
  setBusy(true);setSelected(key);setMessage('Waiting for the conversation challenge…');
  try{
   await ringSend(r.secret,'identity',{key},c.signal);
   const value=await ringReceive(r.secret,'challenge',c.signal) as {statement:string;delegate:string};
   if(c.signal.aborted)return;
   if(value.delegate!==r.delegate)throw new Error('Delegate mismatch');
   inspectRingStatement(value.statement,key);setStatement(value.statement);setMessage('Approve this conversation proof?');
  }catch{if(!c.signal.aborted)setMessage('Unable to receive a valid challenge. Cancel and start again.');}
  finally{setBusy(false);}
 }
 async function approve(){
  const r=request.current,c=controller.current;if(!r||!c||busy||!statement)return;
  setBusy(true);
  let seed:Uint8Array|undefined;
  try{
   const details=inspectRingStatement(statement,selected);
   // Access only the identity explicitly selected and approved in this Ring app.
   const result=await getPubkySecretKey(selected);if(result.isErr())throw new Error('Identity unavailable');
   if(!/^[a-fA-F0-9]{64}$/.test(result.value.secretKey))throw new Error('Unsupported secret encoding');
   seed=Uint8Array.from(result.value.secretKey.match(/../g)!,x=>parseInt(x,16));
   if(c.signal.aborted)return;
   const authorization=ringAuthorization(ringClaims(statement,selected,r.delegate,details.issuedAt,details.expiresAt),seed);
   seed.fill(0);seed=undefined;
   await ringSend(r.secret,'approval',{authorization},c.signal);
   if(c.signal.aborted)return;
   setDone(true);setStatement('');setMessage('Approved. Return to Ghostly; your contact will verify the proof. Your main key stayed in Ring.');cleanup();
  }catch{if(!c.signal.aborted)setMessage('Approval failed. Cancel and request a new QR code.');}
  finally{seed?.fill(0);setBusy(false);}
 }
 async function cancel(){
  const r=request.current,c=controller.current;
  if(r&&c&&!c.signal.aborted){const body={cancelled:true};await Promise.race([ringSend(r.secret,selected?'approval':'identity',body,c.signal).catch(()=>{}),new Promise<void>(resolve=>setTimeout(resolve,800))]);}
  cleanup();setVisible(false);setStatement('');setSelected('');
 }
 let details:ReturnType<typeof inspectRingStatement>|undefined;
 try{if(statement)details=inspectRingStatement(statement,selected);}catch{/* stale proof disables approval */}
 return <Modal visible={visible} animationType="slide" onRequestClose={()=>void cancel()}><View style={styles.container}><ScrollView contentContainerStyle={styles.content}>
  <Text style={styles.tag}>RING · EXPERIMENTAL GHOSTLY EXTENSION</Text><Text style={styles.title}>Connect with Ghostly</Text>
  <Text style={styles.text}>{message}</Text>
  {!done&&<Text style={styles.muted}>One conversation. Valid for 10 minutes. No homeserver access, public post, or login session.</Text>}
  {!selected&&!done&&Object.entries(keys).map(([key,value])=><Pressable key={key} disabled={busy||!request.current} style={styles.card} onPress={()=>void choose(key)} accessibilityRole="button" accessibilityLabel={`Choose ${value.name||'Pubky identity'}`}><Text style={styles.text}>{value.name||'Pubky identity'}</Text><Text style={styles.muted}>{key}</Text></Pressable>)}
  {!selected&&!done&&<Pressable style={styles.card} disabled={busy||!request.current} onPress={async()=>{setBusy(true);const res=await createNewPubky(dispatch);setBusy(false);if(res.isErr())setMessage('Could not create a disposable identity.');}} accessibilityRole="button"><Text style={styles.text}>Create a disposable test identity</Text><Text style={styles.muted}>Generated and kept inside this isolated Ring build.</Text></Pressable>}
  {!!selected&&<Text style={styles.muted}>Selected identity: {selected}</Text>}
  {details&&<View style={styles.card}><Text style={styles.text}>Your Ghostly participation</Text><Text selectable style={styles.muted}>{details.subject}</Text><Text style={styles.text}>Contact participation</Text><Text selectable style={styles.muted}>{details.audience}</Text><Text style={styles.text}>Compare in Ghostly before approval</Text><Text selectable style={styles.code}>{details.context.slice(0,16)}</Text><Text style={styles.muted}>Expires {new Date(details.expiresAt*1000).toLocaleTimeString()}. This authorizes only this challenge. It cannot sign another conversation or access your account. An issued proof cannot be recalled from remote copies; stop sharing in Ghostly or wait for expiry.</Text></View>}
  {details&&<Pressable style={styles.approve} disabled={busy} onPress={()=>void approve()} accessibilityRole="button"><Text style={styles.approveText}>{busy?'Sending…':'Approve this conversation'}</Text></Pressable>}
  <Pressable style={styles.card} onPress={()=>void cancel()} accessibilityRole="button"><Text style={styles.text}>{done?'Done':'Cancel'}</Text></Pressable>
 </ScrollView></View></Modal>;
}
const styles=StyleSheet.create({container:{flex:1,backgroundColor:'#111820'},content:{padding:24,paddingTop:70,gap:20},tag:{color:'#70d6ec',fontSize:11,fontWeight:'700'},title:{color:'#fff',fontSize:30,fontWeight:'700'},text:{color:'#f1f5f9',fontSize:16,lineHeight:23},muted:{color:'#a5b7c8',fontSize:12,lineHeight:19},code:{color:'#70d6ec',fontSize:22,fontWeight:'700'},card:{borderWidth:1,borderColor:'#334455',borderRadius:16,padding:16,gap:8},approve:{backgroundColor:'#70d6ec',borderRadius:16,padding:18},approveText:{color:'#111820',textAlign:'center',fontSize:16,fontWeight:'700'}});

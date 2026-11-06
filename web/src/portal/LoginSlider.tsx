import {useEffect,useRef,useState} from 'react';
import {call,type Row} from './client';
import './partners.css';
export default function LoginSlider({onVerified}:{onVerified:(proof:string)=>void}){
 const [challenge,setChallenge]=useState<Row|null>(null),[x,setX]=useState(0),[busy,setBusy]=useState(false),[passed,setPassed]=useState(false),[error,setError]=useState('');
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),generation=useRef(0);
 async function reset(){
  const current=++generation.current;clearTimeout(timer.current);onVerified('');setPassed(false);setX(0);setError('');setBusy(true);
  try{const v=await call('/api/auth/slider');if(current===generation.current)setChallenge(v)}catch(e){if(current===generation.current)setError((e as Error).message)}finally{if(current===generation.current)setBusy(false)}
 }
 async function verify(value:number){
  if(busy||passed||!challenge?.id)return;setBusy(true);setError('');
  try{const v=await call('/api/auth/slider/verify','POST',{id:challenge.id,x:value});setPassed(true);onVerified(v.proof);timer.current=setTimeout(()=>void reset(),v.expires_in*1000)}catch(e){setChallenge(null);onVerified('');setError((e as Error).message)}finally{setBusy(false)}
 }
 useEffect(()=>{void reset();return()=>{generation.current++;clearTimeout(timer.current)}},[]);
 return <section className="p-login-slider" aria-label="登录滑动验证"><div className="p-slider-title"><span>{passed?'验证通过':busy?'正在验证…':'拖动滑块，对齐图中的深色位置'}</span><button type="button" disabled={busy} onClick={()=>reset()}>换一张</button></div>
 {challenge?.enabled&&!passed&&<><div className="p-slider-canvas"><img src={challenge.image} alt="将滑块移至图中的深色位置"/><span style={{left:`${x/320*100}%`}}/></div><input type="range" min={0} max={284} step={1} value={x} aria-label="移动验证滑块" disabled={busy} onChange={e=>setX(Number(e.target.value))} onPointerUp={e=>verify(Number(e.currentTarget.value))} onKeyUp={e=>{if(['ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(e.key))void verify(Number(e.currentTarget.value))}}/></>}
 {passed&&<p role="status">✓ 滑动验证完成</p>}{challenge?.enabled===false&&<p role="status">当前无需滑动验证</p>}{error&&<p role="alert">{error}，请点击“换一张”。</p>}</section>;
}

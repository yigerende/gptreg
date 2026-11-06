import { afterEach, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "../router";
import AdminAccounts from "./AdminAccounts";
import AdminPlatform from "./AdminPlatform";
import * as client from "./client";
const queries: QueryClient[] = [];
afterEach(()=>{cleanup();queries.splice(0).forEach(q=>q.clear());vi.restoreAllMocks();});
function mount(node: React.ReactNode) {
  const q=new QueryClient({defaultOptions:{queries:{retry:false}}});queries.push(q);
  return render(<QueryClientProvider client={q}><Router>{node}</Router></QueryClientProvider>);
}
const group=(id:string)=>({id,order_id:id,owner_email:"customer@example.test",available_count:600,need_oauth:true});
const cost={attempts:2,missing:0,pending:true,mail:{USD:{confirmed:.034,pending:.017}},sms:{CNY:{confirmed:.25,pending:0}}};
it.each([true,false])('admin credentials display complete AT Session RT and device details, OAuth present=%s',async hasOAuth=>{
  const token='full-session-'+'x'.repeat(12000);
  vi.spyOn(client,'call').mockImplementation(async path=>{
    if(path.endsWith('/credentials'))return {email:'one@gmail.com',password:'test',totp_secret:'TEST_2FA',totp_code:'123456',access_token:'WEB_AT',session_token:token,oauth:hasOAuth?{access_token:'OAUTH_AT',refresh_token:'FULL_RT'}:undefined,delivery:{id:'a',order_id:'one',owner_email:'owner@example.test'}};
    if(path.endsWith('/device-fingerprint'))return {device_fingerprint:{fingerprint:'ADMIN_FP',profile:{}}};
    return {total:1,items:[{id:'a',email:'one@gmail.com',order_id:'one'}]};
  });
  mount(<AdminAccounts rows={[group('one')]} onOrder={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:/订单 one/}));await screen.findByText('one@gmail.com');
  fireEvent.click(screen.getByRole('button',{name:'查看设备指纹'}));expect(await screen.findByDisplayValue('ADMIN_FP')).toBeVisible();
  fireEvent.click(screen.getByRole('button',{name:'关闭'}));
  fireEvent.click(screen.getByRole('button',{name:'查看凭据'}));
  expect(await screen.findByDisplayValue(token)).toHaveValue(token);
  expect(screen.getByRole('textbox',{name:'网页登录 AT'})).toHaveValue('WEB_AT');
  expect(screen.getByRole('textbox',{name:'RT（Refresh Token）'})).toHaveValue(hasOAuth?'FULL_RT':'');
  expect(screen.getByRole('textbox',{name:'邮箱'})).toHaveValue('one@gmail.com');
  expect(screen.getByRole('textbox',{name:'密码'})).toHaveValue('test');
  expect(screen.getByRole('textbox',{name:'2FA 密钥'})).toHaveValue('TEST_2FA');
  expect(screen.getByRole('textbox',{name:'当前验证码'})).toHaveValue('123456');
  expect(screen.getByRole('button',{name:'刷新验证码'})).toBeVisible();
  const copied=vi.spyOn(client,'copy').mockResolvedValue();
  fireEvent.click(screen.getByRole('button',{name:'复制完整 Session Token'}));
  await waitFor(()=>expect(copied).toHaveBeenCalledWith(token));
  fireEvent.click(screen.getByRole('button',{name:'展开完整 Session Token'}));
  expect(screen.getByRole('textbox',{name:'完整 Session Token完整内容'})).toHaveValue(token);

});
it("delivery groups lazily load accounts, keep cross-order selection capped at 1000 and export exact selected IDs",async()=>{
  const exported=vi.spyOn(client,"download").mockImplementation(()=>{});
  const calls: string[]=[];
  let posted:any;
  vi.spyOn(globalThis,"fetch").mockImplementation(async (input,init)=>{
    const url=new URL(String(input),"http://local");calls.push(url.pathname+url.search);
    if(url.pathname.endsWith('/export')) {posted=JSON.parse(String(init?.body));return new Response(JSON.stringify({filename:"accounts.json",content:"[]"}));}
    const order=url.searchParams.get('order_id')||'one',offset=Number(url.searchParams.get('offset')||0),limit=Number(url.searchParams.get('limit')||50);
    return new Response(JSON.stringify({total:600,items:Array.from({length:Math.min(limit,600-offset)},(_,n)=>({id:`${order}-${n+offset}`,order_id:order,email:`${order}-${n+offset}@gmail.com`,execution_cost:cost}))}));
  });
  mount(<AdminAccounts rows={[group("one"),group("two")]} onOrder={()=>{}}/>);
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:/订单 one/}));
  await screen.findByText('one-0@gmail.com');expect(calls).toHaveLength(1);
  expect(screen.queryByText('two-0@gmail.com')).toBeNull();
  fireEvent.click(screen.getAllByRole('button',{name:'选择 / 取消本单'})[0]);
  await screen.findByText('已选 600 个');
  fireEvent.click(screen.getAllByRole('button',{name:'选择 / 取消本单'})[1]);
  await screen.findByText('已选 1000 个');
  fireEvent.click(screen.getByRole('button',{name:'导出完整 JSON'}));
  await waitFor(()=>expect(exported).toHaveBeenCalledOnce());
  expect(posted.ids).toHaveLength(1000);expect(new Set(posted.ids).size).toBe(1000);
  expect(posted.ids.filter((id:string)=>id.startsWith('one-'))).toHaveLength(600);
  expect(calls.every(x=>!x.includes('/credentials'))).toBe(true);
  for(const [label,format] of [["邮箱+AT","email_at"],["邮箱+Session","email_session"]]) {
    fireEvent.click(screen.getByRole('button',{name:label}));
    await waitFor(()=>expect(posted.format).toBe(format));
    await waitFor(()=>expect((screen.getByRole('button',{name:label}) as HTMLButtonElement).disabled).toBe(false));
  }
  fireEvent.click(screen.getAllByRole('button',{name:'选择 / 取消本单'})[1]);
  await screen.findByText('已选 600 个');
});
it("order monitoring opens details through its action button and keeps provider costs distinct from points",async()=>{
  const order={id:'order-for-detail',quantity:1,delivered:1,status:'completed',unit_price:50,charged:50,execution_cost:cost};
  vi.spyOn(globalThis,"fetch").mockImplementation(async input=>new Response(JSON.stringify(String(input).includes('/orders/order-for-detail')?{...order,items:[],attempts:[]}:{items:[order],total:1})));
  mount(<AdminPlatform tab="orders"/>);
  const button=await screen.findByRole('button',{name:'订单详情'});
  expect(screen.queryByRole('button',{name:/order-for-de/})).toBeNull();
  fireEvent.click(button);await screen.findByRole('dialog',{name:'订单详情'});
  await screen.findByText('本订单执行成本');
  expect(screen.getAllByText('0.034 USD').length).toBeGreaterThan(0);
  expect(screen.getAllByText('0.25 CNY').length).toBeGreaterThan(0);
});

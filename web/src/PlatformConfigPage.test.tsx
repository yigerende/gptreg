import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlatformConfigPage } from './PlatformConfigPage';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const fields = [{path:'mail.timeoutMs',group:'邮箱',label:'邮箱等待时间',type:'number',value:120000,defaultValue:120000,min:1000,max:3600000,help:'毫秒'}, {path:'sms.replacementBudget',group:'短信',label:'换号次数',type:'number',value:20,defaultValue:20,min:0,max:30,help:''}];
function show() { render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><PlatformConfigPage /></QueryClientProvider>); }
it('keeps edits when filtering and saves only edited tuning fields', async () => {
  const calls: Array<any> = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({url,method:init?.method,body:init?.body&&JSON.parse(init.body)});
    return new Response(JSON.stringify(String(url).endsWith('/platform-config') ? {fields} : {resource_retry_limit:2,attempt_limit:2}));
  }));
  show();
  fireEvent.change(await screen.findByLabelText('邮箱等待时间'),{target:{value:'90000'}});
  fireEvent.change(screen.getByLabelText('搜索配置'),{target:{value:'换号'}});
  expect(screen.queryByLabelText('邮箱等待时间')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/保存运行参数/}));
  await waitFor(()=>expect(calls.some(c=>c.method==='PUT')).toBe(true));
  expect(calls.find(c=>c.method==='PUT').body).toEqual({values:{'mail.timeoutMs':90000}});
  expect(calls.some(c=>c.method==='PATCH')).toBe(false);
});
it('saving order limits leaves other settings untouched and preserves edits when server rejects', async () => {
  let body:any;
  vi.stubGlobal('fetch',vi.fn(async (url,init)=> {
    if(init?.method==='PATCH') {body=JSON.parse(init.body);return new Response(JSON.stringify({error:'配置被拒绝'}),{status:400});}
    return new Response(JSON.stringify(String(url).endsWith('/platform-config')?{fields}:{resource_retry_limit:2,attempt_limit:2}));
  }));
  show();
  const input=await screen.findByLabelText(/未交付账号最多换邮箱次数/);
  fireEvent.change(input,{target:{value:'3'}});
  fireEvent.click(screen.getByRole('button',{name:'保存订单参数'}));
  expect(await screen.findByText('配置被拒绝')).toBeInTheDocument();
  expect(body).toEqual({resource_retry_limit:3}); expect(input).toHaveValue(3);
});

import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Tooltip } from 'radix-ui';
import ProxyInventory from './ProxyInventory';
const clients: QueryClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.clear());vi.restoreAllMocks()});
function mount(){const c=new QueryClient({defaultOptions:{queries:{retry:false}}});clients.push(c);render(<QueryClientProvider client={c}><Tooltip.Provider><ProxyInventory/></Tooltip.Provider></QueryClientProvider>)}
it('loads actual pages, submits filters and tests selected proxies with visible progress',async()=>{
  let job: any=null;
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const url=new URL(String(input),'http://local');
    if(init?.method==='POST'){job={id:'job',status:'running',done:0,total:1,succeeded:0,failed:0};return new Response(JSON.stringify(job))}
    const offset=Number(url.searchParams.get('offset')||0);
    return new Response(JSON.stringify({items:[{id:'p'+offset,scope:'country',countryCode:'JP',provider:'711proxy',providerLabel:'711Proxy',sourceId:'s1',protocol:'http',endpoint:`http://proxy${offset}.test:8080`,sessionMinutes:10,pulledAt:'',check:null}],total:120,offset,limit:50,countries:['JP'],providers:[{value:'711proxy',label:'711Proxy'}],summary:{total:120,matched:120,healthy:0,failed:0,unknown:120},test:job}));
  });
  mount();await screen.findByText('http://proxy0.test:8080');
  fireEvent.click(screen.getByRole('button',{name:'下一页'}));await screen.findByText('http://proxy50.test:8080');
  fireEvent.change(screen.getByLabelText('搜索代理'),{target:{value:'8080'}});fireEvent.click(screen.getByRole('button',{name:'查询'}));
  await waitFor(()=>expect(fetcher.mock.calls.some(([u])=>String(u).includes('q=8080')&&String(u).includes('offset=0'))).toBe(true));
  await screen.findByText('http://proxy0.test:8080');fireEvent.click(screen.getByLabelText('选择本页代理'));fireEvent.click(screen.getByRole('button',{name:'测试已选'}));
  await screen.findByRole('progressbar',{name:'代理测试进度'});
  expect(screen.getByRole('button',{name:'测试已选'})).toBeDisabled();
  const post=fetcher.mock.calls.find(([,i])=>i?.method==='POST')!;
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({ids:['p0'],filters:{q:'8080'}});
});

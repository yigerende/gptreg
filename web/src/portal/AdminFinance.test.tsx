import {afterEach,it,expect,vi} from "vitest";
import {render,screen,fireEvent,waitFor,cleanup} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import AdminFinance from "./AdminFinance";
import * as client from "./client";
let q:QueryClient;
afterEach(()=>{cleanup();q?.clear();vi.restoreAllMocks();});
it("finance defaults to members, keeps raw points, applies time/account filters and exports with feedback",async()=>{
  const paths:string[]=[];
  const cost={attempts:1,missing:0,mail:{USD:{confirmed:.017}},sms:{CNY:{confirmed:.2}}};
  vi.spyOn(globalThis,"fetch").mockImplementation(async input=>{
    const url=String(input);paths.push(url);
    if(url.includes('/export'))return new Response('账户,余额\nclient@example.test,975');
    return new Response(JSON.stringify({start:'2026-11-01',end:'2026-11-05',totals:{credited:1000,spent:50,adjusted:25,released:50},current:{balance:975,frozen:0},trend:[{period:'2026-11-05',credited:1000,spent:50}],users:[{id:'u',email:'client@example.test',name:'客户',balance:975,frozen:0,execution_cost:cost}],users_total:1,items:[],total:0,execution_cost:cost}));
  });
  const download=vi.spyOn(client,'download').mockImplementation(()=>{});
  q=new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={q}><AdminFinance/></QueryClientProvider>);
  await screen.findByText('每位客户的资金明细');
  expect(paths[0]).toContain('include_admin=false');expect(screen.getAllByText('975').length).toBeGreaterThan(0);
  expect(screen.getAllByText('0.017 USD').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button',{name:'每月'}));await waitFor(()=>expect(paths.at(-1)).toContain('period=month'));
  fireEvent.click(screen.getByLabelText('包含管理员'));await waitFor(()=>expect(paths.at(-1)).toContain('include_admin=true'));
  fireEvent.change(screen.getByLabelText('搜索账户'),{target:{value:'client@example.test'}});
  fireEvent.click(screen.getByRole('button',{name:'查询'}));await waitFor(()=>expect(paths.at(-1)).toContain('q=client%40example.test'));
  fireEvent.click(screen.getByRole('button',{name:'导出报表'}));await waitFor(()=>expect(download).toHaveBeenCalledOnce());
  expect(download.mock.calls[0][1]).toMatch(/^\uFEFF账户/);
  expect(paths.some(path=>path.includes('/finance/export?')&&path.includes('include_admin=true'))).toBe(true);await screen.findByText('财务报表已导出');
});

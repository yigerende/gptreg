import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminCosts, { CostAmount, ResourceCost } from "./AdminCosts";
import AdminOrderActions from "./AdminOrderActions";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const usage = {total:3,succeeded:1,failed:2,active:0,unknown:0,cancelled:1,cancel_failed:1,cleanup_pending:0,review:0,
  price_unknown:0,uncounted:0,missing_attempts:0,failed_cost:{USD:{confirmed:.017,pending:.017,refunded:0}},
  reasons:[{code:'EMAIL_OTP_TIMEOUT',count:2}],cleanup_reasons:[{code:'MAILBOX_STATE_REJECTED',count:1}]};
const cost = {version:2,attempts:3,missing:0,pending:true,mail:{USD:{confirmed:.034,pending:.017}},sms:{CNY:{confirmed:.1,pending:.03}},
  kind_pending:{mail:true,sms:true},resources:{mail:usage,sms:{...usage,failed_cost:{CNY:{confirmed:.02,pending:.03,refunded:.01}}}}};
it("SMS pending never marks a settled mailbox column pending", () => {
  const {rerender}=render(<CostAmount cost={{...cost,kind_pending:{mail:false,sms:true},mail:{USD:{confirmed:.017}}}} kind="mail"/>);
  expect(screen.getByText('0.017 USD')).toBeVisible();expect(screen.queryByText('费用尚未全部结算')).not.toBeInTheDocument();
  rerender(<CostAmount cost={cost} kind="sms"/>);
  expect(screen.getByText('费用尚未全部结算')).toBeVisible();expect(screen.getByText('待核对 0.03 CNY')).toBeVisible();
});
it("resource counts, failed-cost subsets and cleanup reasons remain distinct", () => {
  render(<AdminCosts cost={cost}/>);
  const mail=within(screen.getByLabelText('邮箱数量与费用'));
  expect(mail.getByText('失败 2')).toBeVisible();expect(mail.getByText('取消成功 1')).toBeVisible();expect(mail.getByText('取消失败 1')).toBeVisible();
  expect(mail.getByText('已确认 0.017 USD')).toBeVisible();expect(mail.getByText('其中失败资源费用（已含在总额）')).toBeVisible();
  expect(mail.getByText('邮箱验证码超时 · 2 次')).toBeInTheDocument();expect(mail.getByText('供应商拒绝关闭租约 · 1 次')).toBeInTheDocument();
  expect(screen.getByText('已退 0.01 CNY')).toBeVisible();
});
it("unknown historical quantities are not presented as complete zero usage", () => {
  const {rerender}=render(<ResourceCost cost={{version:1,mail:{USD:{confirmed:.017}}}} kind="mail"/>);
  expect(screen.getByText('历史数量待补齐')).toBeVisible();expect(screen.queryByText('失败 0')).not.toBeInTheDocument();
  rerender(<ResourceCost cost={{...cost,resources:{mail:{...usage,missing_attempts:2,price_unknown:1}}}} kind="mail"/>);
  expect(screen.getByText('历史数量不完整（2 次执行待补齐）')).toBeVisible();
  expect(screen.getByText('1 个资源未记录价格，费用待核对')).toBeVisible();
});
it("order details include per-account costs, per-attempt errors and independent cleanup status", () => {
  const query = new QueryClient();
  render(<QueryClientProvider client={query}><AdminOrderActions data={{execution_cost:cost,
    items:[{id:'item1',position:7,status:'failed',execution_cost:cost}],
    attempts:[{id:'a',item_id:'item1',run_id:'run-7',stage:'register',status:'finished',error_code:'EMAIL_OTP_TIMEOUT',error_detail:'验证码等待超时',cost_snapshot:cost}],
    cleanup_runs:[{run_id:'run-7',attempts:2,last_error:'供应商繁忙',next_attempt_at:'2026-11-06T02:00:00Z'}]}}/></QueryClientProvider>);
  expect(screen.getByText('逐账号资源消耗与失败情况')).toBeVisible();
  expect(screen.getByText('失败待重试')).toBeInTheDocument();expect(screen.getByText('供应商繁忙')).toBeInTheDocument();
  expect(screen.getByText('验证码等待超时')).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'run-7',hidden:true})).toHaveAttribute('href','/admin/engine/run/run-7');
  query.clear();
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bestCampaign,
  campaignOfferKind,
  campaignOfferLabel,
  describeCampaign,
  isFreeMonthCampaign,
  campaignPlanLabel,
  isChainRedeemableTrial,
  isFreeMonthTrial,
  offerSummary,
  redeemableCampaign,
} = require('../src/trial-offer');

const FREE_MONTH = { key: 'plus', planName: 'chatgptplusplan', durationPeriods: 1, durationPeriod: 'month', discountPercentage: 100 };
const HALF_PRICE_QUARTER = { key: 'go', planName: 'chatgptgoplan', durationPeriods: 3, durationPeriod: 'month', discountPercentage: 50 };
const HALF_PRICE_MONTH = { key: 'plus', planName: 'chatgptplusplan', durationPeriods: 1, durationPeriod: 'month', discountPercentage: 50 };
const FREE_QUARTER = { key: 'plus', planName: 'chatgptplusplan', durationPeriods: 3, durationPeriod: 'month', discountPercentage: 100 };

test('only a fully discounted single month counts as a redeemable free month', () => {
  assert.equal(isFreeMonthCampaign(FREE_MONTH), true);
  // A free run longer than a month is not what `plus-1-month-free` grants.
  assert.equal(isFreeMonthCampaign(FREE_QUARTER), false);
  assert.equal(isFreeMonthCampaign(HALF_PRICE_MONTH), false);
  assert.equal(isFreeMonthCampaign(HALF_PRICE_QUARTER), false);
  assert.equal(isFreeMonthCampaign({}), false);
});

test('the period unit is part of the test, not just the count', () => {
  assert.equal(isFreeMonthCampaign({ durationPeriods: 1, durationPeriod: 'week', discountPercentage: 100 }), false);
  assert.equal(isFreeMonthCampaign({ durationPeriods: 1, durationPeriod: 'MONTH', discountPercentage: 100 }), true);
});

test('offer kinds separate a free month from any other promo', () => {
  assert.equal(campaignOfferKind(FREE_MONTH), 'free_month');
  assert.equal(campaignOfferKind(FREE_QUARTER), 'free_other');
  assert.equal(campaignOfferKind(HALF_PRICE_QUARTER), 'discounted');
});

test('labels read as the operator would say them out loud, and name the plan', () => {
  // The plan is part of the label because `1个月免费` on Go and on Plus are the
  // same words for two different subscriptions.
  assert.equal(campaignOfferLabel(FREE_MONTH), 'Plus 1个月免费');
  assert.equal(campaignOfferLabel(HALF_PRICE_QUARTER), 'Go 3个月半价');
  assert.equal(campaignOfferLabel({ planName: 'chatgptplusplan', durationPeriods: 2, durationPeriod: 'week', discountPercentage: 30 }), 'Plus 2周减30%');
  // No plan on the campaign: the offer still reads, just without a prefix.
  assert.equal(campaignOfferLabel({ durationPeriods: 1, durationPeriod: 'year', discountPercentage: 100 }), '1年免费');
  // A campaign with no usable duration still gets a price word rather than ''.
  assert.equal(campaignOfferLabel({ discountPercentage: 0 }), '试用');
});

test('the plan label is the readable half of the API plan name', () => {
  assert.equal(campaignPlanLabel({ planName: 'chatgptplusplan' }), 'Plus');
  assert.equal(campaignPlanLabel({ planName: 'chatgptgoplan' }), 'Go');
  assert.equal(campaignPlanLabel({ planName: 'chatgptproplan' }), 'Pro');
  // An unseen plan is stripped of the wrapper rather than shown raw or dropped.
  assert.equal(campaignPlanLabel({ planName: 'chatgptteamplan' }), 'Team');
  assert.equal(campaignPlanLabel({}), '');
});

test('describeCampaign annotates without dropping the original fields', () => {
  const described = describeCampaign(HALF_PRICE_QUARTER);
  assert.equal(described.planName, 'chatgptgoplan');
  assert.equal(described.discountPercentage, 50);
  assert.equal(described.offerKind, 'discounted');
  assert.equal(described.offerLabel, 'Go 3个月半价');
  assert.equal(described.offerPlanLabel, 'Go');
});

test('the best campaign is the one worth acting on, whatever the input order', () => {
  assert.equal(bestCampaign([HALF_PRICE_QUARTER, FREE_MONTH]).key, 'plus');
  assert.equal(bestCampaign([FREE_MONTH, HALF_PRICE_QUARTER]).key, 'plus');
  assert.equal(bestCampaign([HALF_PRICE_QUARTER, FREE_QUARTER]).discountPercentage, 100);
  assert.equal(bestCampaign([]), null);
  assert.equal(bestCampaign(null), null);
});

test('the folded summary is what the tag and the chain gate both read', () => {
  assert.deepEqual(offerSummary([FREE_MONTH]), { offerKind: 'free_month', offerLabel: 'Plus 1个月免费', offerPlan: 'chatgptplusplan', offerPlanLabel: 'Plus', freeMonthOffer: true });
  assert.deepEqual(offerSummary([HALF_PRICE_QUARTER]), { offerKind: 'discounted', offerLabel: 'Go 3个月半价', offerPlan: 'chatgptgoplan', offerPlanLabel: 'Go', freeMonthOffer: false });
  assert.deepEqual(offerSummary([]), { offerKind: '', offerLabel: '', offerPlan: '', offerPlanLabel: '', freeMonthOffer: false });
});

test('a stored trial is graded from its campaigns so old records need no re-check', () => {
  assert.equal(isFreeMonthTrial({ campaigns: [FREE_MONTH] }), true);
  assert.equal(isFreeMonthTrial({ campaigns: [HALF_PRICE_QUARTER] }), false);
  // A record predating the campaign list, but carrying the persisted flag.
  assert.equal(isFreeMonthTrial({ freeMonthOffer: true }), true);
  // The campaign list wins over a flag that disagrees with it: the list is the
  // raw observation, the flag is only a cached verdict.
  assert.equal(isFreeMonthTrial({ campaigns: [HALF_PRICE_QUARTER], freeMonthOffer: true }), false);
  assert.equal(isFreeMonthTrial(null), false);
  assert.equal(isFreeMonthTrial({}), false);
});

const GO_FREE_MONTH = { key: 'go', id: 'go-1-month-free', planName: 'chatgptgoplan', durationPeriods: 1, durationPeriod: 'month', discountPercentage: 100 };

test('only a free month on Plus is redeemable', () => {
  assert.equal(redeemableCampaign([FREE_MONTH]).planName, 'chatgptplusplan');
  // A Go free month is a real one-month free trial, and deliberately not
  // redeemable here: extracting it buys a Go subscription.
  assert.equal(redeemableCampaign([GO_FREE_MONTH]), null);
  assert.equal(redeemableCampaign([GO_FREE_MONTH, HALF_PRICE_MONTH]), null);
  assert.equal(redeemableCampaign([GO_FREE_MONTH, FREE_MONTH]).planName, 'chatgptplusplan');
  assert.equal(redeemableCampaign([HALF_PRICE_MONTH, HALF_PRICE_QUARTER]), null);
  assert.equal(redeemableCampaign([]), null);
});

test('the chain gate reads the campaign list, and falls back for legacy records', () => {
  assert.equal(isChainRedeemableTrial({ campaigns: [FREE_MONTH] }), true);
  assert.equal(isChainRedeemableTrial({ campaigns: [GO_FREE_MONTH] }), false);
  // `isFreeMonthTrial` still answers the broader question, so the tag can tell
  // a Go free month apart from a plain discount.
  assert.equal(isFreeMonthTrial({ campaigns: [GO_FREE_MONTH] }), true);
  // No campaign list: graded on the recorded plan rather than dropped.
  assert.equal(isChainRedeemableTrial({ freeMonthOffer: true, offerPlan: 'chatgptplusplan' }), true);
  assert.equal(isChainRedeemableTrial({ freeMonthOffer: true, offerPlan: 'chatgptgoplan' }), false);
  assert.equal(isChainRedeemableTrial({ freeMonthOffer: false, offerPlan: 'chatgptplusplan' }), false);
  assert.equal(isChainRedeemableTrial(null), false);
});

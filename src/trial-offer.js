'use strict';

const { truthyText: text } = require('./util/shared');

/**
 * Classification of the promo campaigns ChatGPT hands back on the account
 * check.
 *
 * Two shapes show up in practice and they are worth very different things:
 * a genuine free month on `chatgptplusplan`, and a discounted run (typically
 * three months at half price, often on `chatgptgoplan`). Only the free month
 * can be turned into a PayPal link by the chain — `checkout/update` asks for
 * the `plus-1-month-free` campaign by name — so the distinction is a hard
 * eligibility gate, not just a label.
 *
 * Kept dependency-free so both the promo checker and the chain ledger can use
 * it without dragging a transport in.
 */

const FREE_DISCOUNT_PERCENTAGE = 100;
const FREE_MONTH_PERIODS = 1;
const FREE_MONTH_PERIOD = 'month';

/** A free month, a longer freebie, or a plain discount. */
const OFFER_FREE_MONTH = 'free_month';
const OFFER_FREE_OTHER = 'free_other';
const OFFER_DISCOUNTED = 'discounted';

const PERIOD_LABELS = { day: '天', week: '周', month: '个月', year: '年' };

function periods(campaign = {}) {
  const value = Number(campaign.durationPeriods || 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function discount(campaign = {}) {
  const value = Number(campaign.discountPercentage || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** True only for the one-month, fully discounted offer the chain can redeem. */
function isFreeMonthCampaign(campaign = {}) {
  return discount(campaign) >= FREE_DISCOUNT_PERCENTAGE
    && periods(campaign) === FREE_MONTH_PERIODS
    && text(campaign.durationPeriod).toLowerCase() === FREE_MONTH_PERIOD;
}

function campaignOfferKind(campaign = {}) {
  if (isFreeMonthCampaign(campaign)) return OFFER_FREE_MONTH;
  return discount(campaign) >= FREE_DISCOUNT_PERCENTAGE ? OFFER_FREE_OTHER : OFFER_DISCOUNTED;
}

function durationLabel(campaign = {}) {
  const count = periods(campaign);
  if (!count) return '';
  const period = text(campaign.durationPeriod).toLowerCase();
  const unit = PERIOD_LABELS[period];
  return unit ? `${count}${unit}` : `${count} ${period || '期'}`.trim();
}

// `chatgptplusplan` -> `Plus`. The API name is not something to show, but the
// plan itself matters a great deal: `1个月免费` on Go and `1个月免费` on Plus are
// both free months and are not remotely the same thing, and a label that hid
// the difference is exactly how a Go campaign got mistaken for a Plus one.
const PLAN_LABELS = { chatgptplusplan: 'Plus', chatgptgoplan: 'Go', chatgptproplan: 'Pro' };

function campaignPlanLabel(campaign = {}) {
  const plan = text(campaign.planName).toLowerCase();
  if (!plan) return '';
  if (PLAN_LABELS[plan]) return PLAN_LABELS[plan];
  // Unknown plan: strip the wrapper the API uses so the tag stays readable.
  const stripped = plan.replace(/^chatgpt/, '').replace(/plan$/, '');
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : '';
}

function priceLabel(campaign = {}) {
  const percentage = discount(campaign);
  if (percentage >= FREE_DISCOUNT_PERCENTAGE) return '免费';
  if (percentage === 50) return '半价';
  if (percentage > 0) return `减${percentage}%`;
  return '试用';
}

/** Short human tag, e.g. `Plus 1个月免费` or `Go 3个月半价`. */
function campaignOfferLabel(campaign = {}) {
  const duration = durationLabel(campaign);
  const price = priceLabel(campaign);
  const offer = duration ? `${duration}${price}` : price;
  const plan = campaignPlanLabel(campaign);
  return plan ? `${plan} ${offer}` : offer;
}

function describeCampaign(campaign = {}) {
  return {
    ...campaign,
    offerKind: campaignOfferKind(campaign),
    offerLabel: campaignOfferLabel(campaign),
    offerPlanLabel: campaignPlanLabel(campaign),
  };
}

const KIND_RANK = { [OFFER_FREE_MONTH]: 0, [OFFER_FREE_OTHER]: 1, [OFFER_DISCOUNTED]: 2 };

/**
 * The campaign worth showing: a redeemable free month wins over a longer
 * freebie, which wins over a discount. Ties keep the incoming order so the
 * caller's sort stays observable.
 */
function bestCampaign(campaigns = []) {
  const list = Array.isArray(campaigns) ? campaigns.filter((entry) => entry && typeof entry === 'object') : [];
  if (!list.length) return null;
  return list.reduce((best, candidate) => (
    KIND_RANK[campaignOfferKind(candidate)] < KIND_RANK[campaignOfferKind(best)] ? candidate : best
  ));
}

/**
 * Folds a campaign list into the three fields the UI and the chain gate read.
 *
 * `freeMonthOffer` is what decides chain eligibility; `offerKind`/`offerLabel`
 * only drive the tag.
 */
function offerSummary(campaigns = []) {
  // The campaign the chain would actually redeem wins, and only when there is
  // none does this fall back to ranking by kind. `bestCampaign` alone ranks by
  // offer kind and nothing else, so an account holding a free month on both Go
  // and Plus got whichever appeared first in the array — meaning the tag could
  // read `Go 1个月免费` while the extraction went and claimed the Plus one.
  const best = redeemableCampaign(campaigns) || bestCampaign(campaigns);
  if (!best) return { offerKind: '', offerLabel: '', offerPlan: '', offerPlanLabel: '', freeMonthOffer: false };
  return {
    offerKind: campaignOfferKind(best),
    offerLabel: campaignOfferLabel(best),
    // Which plan the headline offer belongs to, carried separately so a caller
    // can act on it rather than parse it back out of the label.
    offerPlan: text(best.planName),
    offerPlanLabel: campaignPlanLabel(best),
    freeMonthOffer: isFreeMonthCampaign(best),
  };
}

/**
 * Chain eligibility for a persisted trial record.
 *
 * The campaign list is re-read rather than trusting `freeMonthOffer` alone so
 * records written before this classification existed are graded correctly
 * without forcing a re-check of every asset.
 */
/** The one plan whose free month is worth extracting. */
const REDEEMABLE_PLAN = 'plus';

/**
 * Renamed off `isPlusPlan`: this asks whether a *campaign* targets the
 * redeemable plan, while `session-asset-grouping.isPlusPlan` asks whether a
 * plan-type *string* says Plus. Two different questions that shared a name.
 */
function campaignTargetsRedeemablePlan(campaign = {}) {
  return text(campaign.planName).toLowerCase().includes(REDEEMABLE_PLAN);
}

/**
 * The campaign the chain should ask `checkout/update` for, or null.
 *
 * A free month on Plus, and nothing else. The Go campaign is also a genuine
 * one-month free trial and it is genuinely redeemable — but what it buys is a
 * Go subscription, which is not what this pipeline exists to produce, so it is
 * excluded here rather than left for the operator to catch from the amount.
 *
 * Returning the campaign itself, rather than a boolean, is what lets the caller
 * send the matching `promo_campaign_id` and `plan_name` instead of a hardcoded
 * pair — which is what made a Go account ask for a Plus campaign it did not
 * hold, and get either a 403 or a silent full-price checkout.
 */
function redeemableCampaign(campaigns = []) {
  const list = Array.isArray(campaigns) ? campaigns.filter((entry) => entry && typeof entry === 'object') : [];
  return list.find((campaign) => isFreeMonthCampaign(campaign) && campaignTargetsRedeemablePlan(campaign)) || null;
}

/**
 * Chain eligibility for a persisted trial record.
 *
 * The campaign list is the source of truth. A record written before the plan
 * mattered carries only `freeMonthOffer`, which cannot say which plan the month
 * was on; those are graded against `subscriptionPlan` as a last resort so a
 * pre-existing asset is not silently dropped from the queue.
 */
function isChainRedeemableTrial(trial) {
  if (!trial || typeof trial !== 'object') return false;
  if (Array.isArray(trial.campaigns) && trial.campaigns.length) {
    return Boolean(redeemableCampaign(trial.campaigns));
  }
  if (trial.freeMonthOffer !== true) return false;
  const plan = text(trial.offerPlan) || text(trial.subscriptionPlan);
  return plan.toLowerCase().includes(REDEEMABLE_PLAN);
}

function isFreeMonthTrial(trial) {
  if (!trial || typeof trial !== 'object') return false;
  if (Array.isArray(trial.campaigns) && trial.campaigns.length) {
    return trial.campaigns.some((campaign) => isFreeMonthCampaign(campaign));
  }
  return trial.freeMonthOffer === true;
}

module.exports = {
  bestCampaign,
  campaignOfferKind,
  campaignOfferLabel,
  campaignPlanLabel,
  describeCampaign,
  isChainRedeemableTrial,
  isFreeMonthCampaign,
  isFreeMonthTrial,
  offerSummary,
  redeemableCampaign,
};

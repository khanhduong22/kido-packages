# @kido/traffic-attribution

Smart Traffic Attribution, AI Agent Detection, Browser Prefetch Filter & Zero-State Cookie Bitmask Rotator for SME Growth & Marketing Platforms.

## Core Features

- 🤖 **AI Agent & Chatbot Recognition**: Detects ChatGPT, Claude, Gemini, Perplexity, Copilot, DeepSeek, and Grok via referer URLs and User-Agents.
- 🚫 **Speculative Prefetch Filtering**: Filters browser prefetch/prerender requests (`sec-purpose: prefetch`, `purpose: prefetch`, `x-moz: prefetch`, `x-prerender`) to prevent artificial click inflation and premature session initialization.
- 🔄 **Zero-State Cookie Bitmask Link Rotator**: Efficient A/B destination link rotation using an integer bitmask (`bit_array & (1 << index)`) stored in client cookies. Zero Redis or session database overhead; automatically resets when the pool cycle completes.
- 🎯 **Dynamic UTM Standardization**: Parses, sanitizes, and injects dynamic UTM parameters while stripping intrusive ad click IDs (`fbclid`, `gclid`, `ttclid`).

## Quick Usage

### 1. Detect AI Agents & Traffic Sources
```ts
import { detectTrafficSource, isAiTraffic } from '@kido/traffic-attribution';

const source = detectTrafficSource({
  referer: req.headers.get('referer'),
  userAgent: req.headers.get('user-agent'),
  internalDomains: ['khanhdp.com', 'tred.vn']
});

console.log(source.channel);  // 'ai_agent' | 'search_engine' | 'social_network' | 'direct' | 'referral'
console.log(source.platform); // 'chatgpt' | 'claude' | 'zalo' | 'tiktok' | 'google'
console.log(isAiTraffic(source)); // true / false
```

### 2. Filter Speculative Prefetch Clicks
```ts
import { isSpeculativePrefetch } from '@kido/traffic-attribution';

if (isSpeculativePrefetch(req.headers)) {
  // Return light 204 or empty response without recording conversion
  return new Response(null, { status: 204 });
}
```

### 3. Rotate Target Links with Zero-State Cookie Bitmask
```ts
import { selectUnvisitedLinkBitmask, createBitmaskCookieString } from '@kido/traffic-attribution';

const landingPages = [
  'https://tred.vn/photobooth-offer-a',
  'https://tred.vn/photobooth-offer-b',
  'https://tred.vn/photobooth-offer-c'
];

const currentCookieMask = req.cookies.get('ab_rot')?.value; // e.g. "1"
const result = selectUnvisitedLinkBitmask(landingPages, currentCookieMask);

console.log(result.selectedItem);   // Next target URL
console.log(result.selectedIndex);  // Index in array
console.log(result.nextBitmask);    // Integer to store back in cookie

// Set-Cookie: ab_rot=<nextBitmask>
res.headers.set('Set-Cookie', createBitmaskCookieString('ab_rot', result.nextBitmask));
```

### 4. Dynamic UTM Processing & Sanitization
```ts
import { resolveUtmParams, injectUtmParams, stripTrackingParameters, buildDynamicUtm } from '@kido/traffic-attribution';

// Clean trackers
const cleanUrl = stripTrackingParameters('https://tred.vn/?fbclid=xyz123&utm_source=fb');

// Auto generate UTM tags from traffic source
const dynamicUtm = buildDynamicUtm(source, { campaign: 'spring_2026' });
const redirectTarget = injectUtmParams('https://app.example.com', dynamicUtm);
```

## Running Tests

```bash
bun test
```

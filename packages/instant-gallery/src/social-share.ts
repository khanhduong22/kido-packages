import {
  EventGallery,
  GuestAccessPass,
  MediaItem,
  SharePlatform,
  SocialSharePayload,
  SocialSharePayloadSchema,
} from './types';

export interface SocialShareOptions {
  customCaption?: string;
  customHashtags?: string[];
  referralCode?: string;
}

/**
 * Generates viral social sharing payloads tailored for 9:16 vertical stories
 * across TikTok, Instagram Reels, Facebook Stories, and Zalo.
 */
export function generateSocialSharePayload(
  mediaItem: MediaItem,
  event: Partial<EventGallery>,
  guestPass?: Partial<GuestAccessPass>,
  options?: SocialShareOptions
): SocialSharePayload {
  const eventName = event.name || 'Sự kiện VIP';
  const openGraphUrl = guestPass?.fullShortUrl || mediaItem.previewUrl;
  const isVideo = mediaItem.type === 'VIDEO_240FPS' || mediaItem.type === 'GIF_BOOMERANG';

  // Base hashtags
  const defaultHashtags = [
    '#TREDMedia',
    '#FotoboothVN',
    '#Glambot360',
    '#LiveGallery',
  ];

  if (event.defaultWatermark?.eventHashtag) {
    const rawTag = event.defaultWatermark.eventHashtag.startsWith('#')
      ? event.defaultWatermark.eventHashtag
      : `#${event.defaultWatermark.eventHashtag}`;
    defaultHashtags.unshift(rawTag);
  }

  if (options?.customHashtags) {
    for (const tag of options.customHashtags) {
      const formatted = tag.startsWith('#') ? tag : `#${tag}`;
      if (!defaultHashtags.includes(formatted)) {
        defaultHashtags.push(formatted);
      }
    }
  }

  const hashtagString = defaultHashtags.join(' ');
  const title = mediaItem.title || `Khoảnh khắc Glambot 360 tại ${eventName}`;
  const description =
    options?.customCaption ||
    `Xem và tải video/ảnh 4K sắc nét của tôi tại sự kiện ${eventName}. Trải nghiệm Live Cloud Gallery bởi T-RED Media!`;

  const captionWithTags = `${description}\n\n${hashtagString}\n${openGraphUrl}`;

  // Encoded urls for web share links
  const encUrl = encodeURIComponent(openGraphUrl);
  const encCaption = encodeURIComponent(captionWithTags);

  const platformTargets: Record<SharePlatform, { shareUrl: string; caption: string }> = {
    FACEBOOK_STORY: {
      shareUrl: `https://www.facebook.com/sharer/sharer.php?u=${encUrl}&quote=${encCaption}`,
      caption: captionWithTags,
    },
    ZALO: {
      shareUrl: `https://sp.zalo.me/share_inline?link=${encUrl}&text=${encCaption}`,
      caption: captionWithTags,
    },
    TIKTOK: {
      shareUrl: `https://www.tiktok.com/upload?caption=${encCaption}`,
      caption: captionWithTags,
    },
    INSTAGRAM_REELS: {
      // Instagram Stories interactive deep link / intent
      shareUrl: `instagram-stories://share?source_application=tred_gallery&content_url=${encUrl}`,
      caption: captionWithTags,
    },
    SYSTEM_SHARE: {
      shareUrl: openGraphUrl,
      caption: captionWithTags,
    },
  };

  const payload: SocialSharePayload = {
    title,
    description,
    openGraphUrl,
    ogImageUrl: mediaItem.thumbnailUrl || mediaItem.previewUrl,
    ogVideoUrl: isVideo ? mediaItem.previewUrl : undefined,
    hashtags: defaultHashtags,
    storyAssetUrl: mediaItem.previewUrl,
    platformTargets,
  };

  return SocialSharePayloadSchema.parse(payload) as SocialSharePayload;
}

/**
 * Generates OpenGraph and Twitter HTML meta tags for SEO and Rich Preview Cards
 */
export function generateOpenGraphMetaTags(payload: SocialSharePayload): string {
  const isVideo = Boolean(payload.ogVideoUrl);
  const ogType = isVideo ? 'video.other' : 'website';

  const tags = [
    `<meta property="og:type" content="${ogType}" />`,
    `<meta property="og:title" content="${escapeHtml(payload.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(payload.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(payload.openGraphUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(payload.ogImageUrl)}" />`,
    `<meta property="og:image:width" content="1080" />`,
    `<meta property="og:image:height" content="1920" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(payload.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(payload.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(payload.ogImageUrl)}" />`,
  ];

  if (payload.ogVideoUrl) {
    tags.push(`<meta property="og:video" content="${escapeHtml(payload.ogVideoUrl)}" />`);
    tags.push(`<meta property="og:video:type" content="video/mp4" />`);
    tags.push(`<meta property="og:video:width" content="1080" />`);
    tags.push(`<meta property="og:video:height" content="1920" />`);
  }

  return tags.join('\n');
}

function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

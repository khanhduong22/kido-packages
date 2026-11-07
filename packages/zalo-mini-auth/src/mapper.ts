import { normalizeVietnamesePhoneNumber } from './phone-utils';
import {
  CustomerProfile,
  CustomerProfileSchema,
  ZaloMiniAppUserInfo,
  ZaloMiniAppUserInfoSchema,
  ZaloUserProfile,
  ZaloUserProfileSchema,
} from './schemas';

export interface MapZaloOAuthOptions {
  phoneNumber?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Maps Zalo OAuth User Profile (/v2.0/me) to universal CustomerProfile DTO.
 */
export function mapZaloOAuthToCustomerProfile(
  rawProfile: unknown,
  options: MapZaloOAuthOptions = {},
): CustomerProfile {
  const profile = ZaloUserProfileSchema.parse(rawProfile);

  const avatar = profile.picture?.data?.url || null;
  const phoneNumber = options.phoneNumber
    ? normalizeVietnamesePhoneNumber(options.phoneNumber) || null
    : null;

  const metadata: Record<string, unknown> = {
    ...options.metadata,
    rawId: profile.id,
  };

  const customerProfile: CustomerProfile = {
    zaloId: profile.id,
    name: profile.name.trim() || 'Người dùng Zalo',
    phoneNumber,
    avatar,
    source: 'zalo_oauth',
    metadata,
  };

  return CustomerProfileSchema.parse(customerProfile);
}

export interface MapZaloMiniAppOptions {
  phoneNumber?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Maps Zalo Mini App User Info (SDK getUserInfo) to universal CustomerProfile DTO.
 */
export function mapZaloMiniAppToCustomerProfile(
  rawUserInfo: unknown,
  options: MapZaloMiniAppOptions = {},
): CustomerProfile {
  const userInfo = ZaloMiniAppUserInfoSchema.parse(rawUserInfo);

  const avatar = userInfo.avatar || null;
  const phoneNumber = options.phoneNumber
    ? normalizeVietnamesePhoneNumber(options.phoneNumber) || null
    : null;

  const metadata: Record<string, unknown> = {
    ...options.metadata,
    idByOA: userInfo.idByOA,
    followedOA: userInfo.followedOA,
    isSensitive: userInfo.isSensitive,
  };

  const customerProfile: CustomerProfile = {
    zaloId: userInfo.id,
    name: userInfo.name.trim() || 'Người dùng Zalo',
    phoneNumber,
    avatar,
    source: 'zalo_mini_app',
    metadata,
  };

  return CustomerProfileSchema.parse(customerProfile);
}

export type UniversalZaloInput =
  | {
      source: 'zalo_oauth';
      profile: unknown;
      phoneNumber?: string | null;
      metadata?: Record<string, unknown>;
    }
  | {
      source: 'zalo_mini_app';
      userInfo: unknown;
      phoneNumber?: string | null;
      metadata?: Record<string, unknown>;
    };

/**
 * Universal mapper supporting both Zalo OAuth and Zalo Mini App sources.
 */
export function mapToCustomerProfile(input: UniversalZaloInput): CustomerProfile {
  if (input.source === 'zalo_oauth') {
    return mapZaloOAuthToCustomerProfile(input.profile, {
      phoneNumber: input.phoneNumber,
      metadata: input.metadata,
    });
  }

  return mapZaloMiniAppToCustomerProfile(input.userInfo, {
    phoneNumber: input.phoneNumber,
    metadata: input.metadata,
  });
}

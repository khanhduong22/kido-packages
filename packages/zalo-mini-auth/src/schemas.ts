import { z } from 'zod';

/**
 * Zalo OAuth 2.0 Token Response Schema
 */
export const ZaloTokensSchema = z.object({
  access_token: z.string().min(1, 'access_token is required'),
  refresh_token: z.string().optional(),
  expires_in: z
    .union([z.number(), z.string()])
    .transform((val) => {
      const num = typeof val === 'string' ? Number.parseInt(val, 10) : val;
      if (Number.isNaN(num)) {
        throw new Error('Invalid expires_in value');
      }
      return num;
    }),
});

export type ZaloTokens = z.infer<typeof ZaloTokensSchema>;

/**
 * Zalo OAuth Error Schema
 */
export const ZaloErrorResponseSchema = z.object({
  error: z.union([z.number(), z.string()]),
  message: z.string().optional(),
  error_description: z.string().optional(),
});

export type ZaloErrorResponse = z.infer<typeof ZaloErrorResponseSchema>;

/**
 * Zalo OpenAPI Phone Data Schema
 */
export const ZaloPhoneDataSchema = z.object({
  number: z.string(),
});

export type ZaloPhoneData = z.infer<typeof ZaloPhoneDataSchema>;

/**
 * Zalo OpenAPI Phone Response Schema (e.g. from /v2.0/me/info)
 */
export const ZaloPhoneResponseSchema = z.object({
  data: ZaloPhoneDataSchema.optional(),
  error: z.number().optional(),
  message: z.string().optional(),
});

export type ZaloPhoneResponse = z.infer<typeof ZaloPhoneResponseSchema>;

/**
 * Token payload from Zalo Mini App SDK `getPhoneNumber()`
 */
export const ZaloPhoneTokenPayloadSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export type ZaloPhoneTokenPayload = z.infer<typeof ZaloPhoneTokenPayloadSchema>;

/**
 * Encrypted payload from Zalo Mini App AES-128-CBC
 */
export const ZaloEncryptedPhonePayloadSchema = z.object({
  encryptedData: z.string().min(1, 'encryptedData is required'),
  iv: z.string().optional(),
});

export type ZaloEncryptedPhonePayload = z.infer<typeof ZaloEncryptedPhonePayloadSchema>;

/**
 * Flexible Zalo Phone Payload Schema accepting token, encrypted data, or direct number
 */
export const ZaloPhonePayloadSchema = z.union([
  ZaloPhoneTokenPayloadSchema,
  ZaloEncryptedPhonePayloadSchema,
  ZaloPhoneDataSchema,
]);

export type ZaloPhonePayload = z.infer<typeof ZaloPhonePayloadSchema>;

/**
 * Zalo User Profile from Graph API (/v2.0/me)
 */
export const ZaloUserProfileSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().default(''),
    picture: z
      .object({
        data: z
          .object({
            url: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type ZaloUserProfile = z.infer<typeof ZaloUserProfileSchema>;

/**
 * Zalo Mini App User Info (from SDK getUserInfo)
 */
export const ZaloMiniAppUserInfoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().default(''),
    avatar: z.string().optional(),
    idByOA: z.string().optional(),
    isSensitive: z.boolean().optional(),
    followedOA: z.boolean().optional(),
  })
  .passthrough();

export type ZaloMiniAppUserInfo = z.infer<typeof ZaloMiniAppUserInfoSchema>;

/**
 * Standardized Unified Customer Profile DTO
 */
export const CustomerProfileSchema = z.object({
  zaloId: z.string().min(1, 'zaloId is required'),
  name: z.string().min(1, 'name is required'),
  phoneNumber: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
  source: z.enum(['zalo_oauth', 'zalo_mini_app']),
  metadata: z.record(z.unknown()).optional(),
});

export type CustomerProfile = z.infer<typeof CustomerProfileSchema>;

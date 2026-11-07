import {
  Permission,
  UserContext,
  ResourceAttributes,
  PermissionDeniedError,
  PolicyRule,
} from './types';
import { getUserContext, requireUserContext } from './tenant-context';
import { evaluatePolicy } from './rbac-abac-engine';

export interface GuardPermissionOptions {
  extractResource?: (req: any) => ResourceAttributes | undefined;
  getUser?: (req: any) => UserContext | undefined;
  onDenied?: (req: any, res: any, violations: string[]) => void;
  throwError?: boolean;
  customRules?: PolicyRule[];
}

/**
 * Checks whether the given user (or the active ambient user context) has access to a permission.
 */
export function canAccess(
  userContext: UserContext | undefined | null,
  permission: Permission,
  resourceAttributes?: ResourceAttributes,
  customRules?: PolicyRule[]
): boolean {
  const user = userContext || getUserContext();
  if (!user) {
    return false;
  }

  const result = evaluatePolicy(user, permission, resourceAttributes, customRules);
  return result.allowed;
}

/**
 * Asserts that the given user has access to a permission.
 * Throws PermissionDeniedError if rejected.
 */
export function assertAccess(
  userContext: UserContext | undefined | null,
  permission: Permission,
  resourceAttributes?: ResourceAttributes,
  customRules?: PolicyRule[]
): void {
  const user = userContext || requireUserContext();
  const result = evaluatePolicy(user, permission, resourceAttributes, customRules);

  if (!result.allowed) {
    throw new PermissionDeniedError(
      permission,
      result.violations,
      user.role
    );
  }
}

/**
 * HTTP / Express / Connect middleware wrapper to protect route endpoints.
 */
export function guardPermission(
  permission: Permission,
  options: GuardPermissionOptions = {}
) {
  return (req: any, res: any, next: (err?: any) => void) => {
    try {
      const user =
        options.getUser?.(req) ||
        req.user ||
        getUserContext();

      if (!user) {
        if (res && typeof res.status === 'function') {
          return res.status(401).json({
            error: 'Unauthorized',
            message: 'User authentication context is missing',
          });
        }
        return next(new PermissionDeniedError(permission, ['Unauthenticated user']));
      }

      const resource = options.extractResource ? options.extractResource(req) : undefined;
      const result = evaluatePolicy(user, permission, resource, options.customRules);

      if (!result.allowed) {
        if (options.onDenied) {
          return options.onDenied(req, res, result.violations);
        }

        if (options.throwError) {
          return next(
            new PermissionDeniedError(permission, result.violations, user.role)
          );
        }

        if (res && typeof res.status === 'function') {
          return res.status(403).json({
            error: 'Forbidden',
            message: `Access denied for permission '${permission}'`,
            violations: result.violations,
          });
        }

        return next(
          new PermissionDeniedError(permission, result.violations, user.role)
        );
      }

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Higher-order function wrapper to protect business logic functions.
 */
export function protectFunction<TArgs extends unknown[], TReturn>(
  permission: Permission,
  fn: (...args: TArgs) => Promise<TReturn> | TReturn,
  options: {
    getUser?: (...args: TArgs) => UserContext | undefined;
    extractResource?: (...args: TArgs) => ResourceAttributes | undefined;
    customRules?: PolicyRule[];
  } = {}
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const user = options.getUser ? options.getUser(...args) : getUserContext();
    const resource = options.extractResource ? options.extractResource(...args) : undefined;

    assertAccess(user, permission, resource, options.customRules);
    return fn(...args);
  };
}

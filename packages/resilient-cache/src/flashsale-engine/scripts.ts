/**
 * Atomic Lua Scripts for Flash Sale Concurrency & Inventory Isolation
 */

/**
 * Reserve Stock Atomically
 * KEYS[1]: Stock Key (e.g. 'flashsale:item:1001:stock')
 * ARGV[1]: Requested Quantity (e.g. 1)
 *
 * Return codes:
 *  >= 0: New stock remaining after reservation
 *  -1: Sold out (stock <= 0 or key not found)
 *  -2: Insufficient stock (current_stock < requested quantity)
 */
export const RESERVE_STOCK_LUA = `
local current_stock = tonumber(redis.call('GET', KEYS[1]))

if not current_stock or current_stock <= 0 then
    return -1
end

if current_stock < tonumber(ARGV[1]) then
    return -2
end

local new_stock = redis.call('DECRBY', KEYS[1], ARGV[1])
return new_stock
`.trim();

/**
 * Compare-And-Delete Lock Release (Redlock Pattern)
 * KEYS[1]: Lock Key (e.g. 'lock:user:123:item:1001')
 * ARGV[1]: Lock Token (UUID)
 *
 * Returns 1 if lock was owned and released, 0 if token mismatch or already expired.
 */
export const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
`.trim();

/**
 * Rollback Reserved Stock Atomically
 * KEYS[1]: Stock Key
 * ARGV[1]: Quantity to restore
 */
export const ROLLBACK_STOCK_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
    redis.call('SET', KEYS[1], ARGV[1])
    return tonumber(ARGV[1])
else
    return redis.call('INCRBY', KEYS[1], ARGV[1])
end
`.trim();

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  createOrderSchema,
  orderFilterQuerySchema,
  updateOrderStatusSchema,
  updatePaymentInfoSchema,
} from '../types';
import {
  type IEcommerceOrderService,
  EcommerceOrderService,
} from './service';
import type { IEcommerceOrderRepository } from './repository';

export interface CreateRoutesOptions {
  service?: IEcommerceOrderService;
  repository?: IEcommerceOrderRepository;
}

export function createEcommerceAdminRoutes(
  optionsOrService?: IEcommerceOrderService | IEcommerceOrderRepository | CreateRoutesOptions
): Hono {
  let service: IEcommerceOrderService;

  if (!optionsOrService) {
    service = new EcommerceOrderService();
  } else if ('getOrder' in optionsOrService && typeof optionsOrService.getOrder === 'function') {
    service = optionsOrService as IEcommerceOrderService;
  } else if ('getOrderById' in optionsOrService && typeof optionsOrService.getOrderById === 'function') {
    service = new EcommerceOrderService(optionsOrService as IEcommerceOrderRepository);
  } else {
    const opts = optionsOrService as CreateRoutesOptions;
    if (opts.service) {
      service = opts.service;
    } else if (opts.repository) {
      service = new EcommerceOrderService(opts.repository);
    } else {
      service = new EcommerceOrderService();
    }
  }

  const router = new Hono();

  // GET /metrics - Aggregated business metrics
  router.get('/metrics', (c) => {
    try {
      const exchangeRateParam = c.req.query('exchangeRate');
      const exchangeRate = exchangeRateParam ? Number(exchangeRateParam) : undefined;
      const metrics = service.getMetrics(exchangeRate);

      return c.json({
        success: true,
        metrics,
      });
    } catch (error: any) {
      return c.json(
        {
          success: false,
          error: error.message || 'Failed to fetch metrics',
        },
        500
      );
    }
  });

  // GET /orders - Paginated order listing with search and filters
  router.get('/orders', zValidator('query', orderFilterQuerySchema), (c) => {
    try {
      const query = c.req.valid('query');
      const result = service.listOrders(query);

      return c.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      return c.json(
        {
          success: false,
          error: error.message || 'Failed to fetch orders',
        },
        500
      );
    }
  });

  // GET /orders/:id - Single order details
  router.get('/orders/:id', (c) => {
    const id = c.req.param('id');
    const order = service.getOrder(id);

    if (!order) {
      return c.json(
        {
          success: false,
          error: `Order '${id}' not found`,
        },
        404
      );
    }

    return c.json({
      success: true,
      order,
    });
  });

  // POST /orders - Create a new order
  router.post('/orders', zValidator('json', createOrderSchema), (c) => {
    try {
      const body = c.req.valid('json');
      const order = service.createOrder(body as any);

      return c.json(
        {
          success: true,
          order,
        },
        201
      );
    } catch (error: any) {
      return c.json(
        {
          success: false,
          error: error.message || 'Failed to create order',
        },
        400
      );
    }
  });

  // PATCH /orders/:id/status - Update order status and notes
  router.patch('/orders/:id/status', zValidator('json', updateOrderStatusSchema), (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const updated = service.updateOrderStatus(id, body.status, body.notes, body.paymentRef);

    if (!updated) {
      return c.json(
        {
          success: false,
          error: `Order '${id}' not found`,
        },
        404
      );
    }

    return c.json({
      success: true,
      order: updated,
    });
  });

  // PATCH /orders/:id/payment - Update payment method and ref
  router.patch('/orders/:id/payment', zValidator('json', updatePaymentInfoSchema), (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const updated = service.updatePaymentInfo(
      id,
      body.paymentMethod,
      body.paymentRef,
      body.status
    );

    if (!updated) {
      return c.json(
        {
          success: false,
          error: `Order '${id}' not found`,
        },
        404
      );
    }

    return c.json({
      success: true,
      order: updated,
    });
  });

  // DELETE /orders/:id - Delete order
  router.delete('/orders/:id', (c) => {
    const id = c.req.param('id');
    const deleted = service.deleteOrder(id);

    if (!deleted) {
      return c.json(
        {
          success: false,
          error: `Order '${id}' not found or could not be deleted`,
        },
        404
      );
    }

    return c.json({
      success: true,
      id,
    });
  });

  return router;
}

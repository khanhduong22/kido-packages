import { useState, useEffect, useCallback, useMemo } from 'react';
import type { AdminOrder, EcommerceMetrics, OrderStatus } from '../types';

export interface UseEcommerceAdminOptions {
  apiBaseUrl?: string; // Default: '/api/admin'
  initialOrders?: AdminOrder[];
  initialMetrics?: EcommerceMetrics | null;
  autoFetch?: boolean;
  exchangeRate?: number;
}

export function useEcommerceAdmin(options: UseEcommerceAdminOptions = {}) {
  const {
    apiBaseUrl = '/api/admin',
    initialOrders = [],
    initialMetrics = null,
    autoFetch = true,
    exchangeRate = 25400,
  } = options;

  const [orders, setOrders] = useState<AdminOrder[]>(initialOrders);
  const [metrics, setMetrics] = useState<EcommerceMetrics | null>(initialMetrics);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeReceiptOrder, setActiveReceiptOrder] = useState<AdminOrder | null>(null);
  const [serverIsLive, setServerIsLive] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchDashboardData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    let hasLiveConnection = false;

    try {
      // 1. Fetch Metrics
      try {
        const metricsRes = await fetch(`${apiBaseUrl}/metrics?exchangeRate=${exchangeRate}`);
        if (metricsRes.ok) {
          const metricsData = await metricsRes.json();
          if (metricsData.success && metricsData.metrics) {
            setMetrics(metricsData.metrics);
            hasLiveConnection = true;
          }
        }
      } catch {
        // Fallback gracefully
      }

      // 2. Fetch Orders
      try {
        const ordersRes = await fetch(`${apiBaseUrl}/orders?limit=100`);
        if (ordersRes.ok) {
          const ordersData = await ordersRes.json();
          if (ordersData.success && Array.isArray(ordersData.orders)) {
            setOrders(ordersData.orders);
            hasLiveConnection = true;
          }
        }
      } catch {
        // Fallback gracefully
      }

      setServerIsLive(hasLiveConnection);
      setLastUpdated(new Date().toLocaleTimeString('vi-VN'));
    } catch (err: any) {
      setError(err.message || 'Error fetching data');
      setServerIsLive(false);
    } finally {
      setIsLoading(false);
    }
  }, [apiBaseUrl, exchangeRate]);

  useEffect(() => {
    if (autoFetch && typeof window !== 'undefined') {
      fetchDashboardData();
    }
  }, [autoFetch, fetchDashboardData]);

  // Update order status via backend API
  const updateOrderStatus = useCallback(
    async (orderId: string, newStatus: OrderStatus | string, notes?: string) => {
      // Optimistic update
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? { ...o, status: newStatus as OrderStatus } : o))
      );

      try {
        const res = await fetch(`${apiBaseUrl}/orders/${orderId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus, notes }),
        });

        if (!res.ok) {
          // If live call fails, keep optimistic state for offline demo
        } else {
          const data = await res.json();
          if (data.success && data.order) {
            setOrders((prev) => prev.map((o) => (o.id === orderId ? data.order : o)));
          }
        }
      } catch {
        // Failed network request
      }
    },
    [apiBaseUrl]
  );

  // Delete order
  const deleteOrder = useCallback(
    async (orderId: string) => {
      // Optimistic delete
      setOrders((prev) => prev.filter((o) => o.id !== orderId));

      try {
        await fetch(`${apiBaseUrl}/orders/${orderId}`, {
          method: 'DELETE',
        });
      } catch {
        // Failed network request
      }
    },
    [apiBaseUrl]
  );

  // Client-side search and filtering
  const filteredOrders = useMemo(() => {
    return orders.filter((order) => {
      // Filter by status
      if (selectedStatus === 'PAID') {
        if (order.status !== 'PAID') return false;
      } else if (selectedStatus === 'PENDING') {
        if (order.status !== 'PENDING' && order.status !== 'PENDING_PAYMENT') return false;
      } else if (selectedStatus === 'SHIPPED') {
        if (order.status !== 'SHIPPED') return false;
      } else if (selectedStatus === 'DELIVERED') {
        if (order.status !== 'DELIVERED') return false;
      } else if (selectedStatus === 'CANCELLED') {
        if (order.status !== 'CANCELLED') return false;
      } else if (selectedStatus === 'VIETQR') {
        if (!order.paymentMethod.toLowerCase().includes('vietqr')) return false;
      } else if (selectedStatus === 'CARD') {
        const pm = order.paymentMethod.toLowerCase();
        if (!pm.includes('card') && !pm.includes('airwallex')) return false;
      }

      // Filter by text search
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchId = order.id.toLowerCase().includes(query);
        const matchName = order.customer.name.toLowerCase().includes(query);
        const matchEmail = order.customer.email.toLowerCase().includes(query);
        const matchPhone = order.customer.phone
          ? order.customer.phone.toLowerCase().includes(query)
          : false;
        const matchRef = order.paymentRef
          ? order.paymentRef.toLowerCase().includes(query)
          : false;

        return matchId || matchName || matchEmail || matchPhone || matchRef;
      }

      return true;
    });
  }, [orders, selectedStatus, searchQuery]);

  return {
    orders,
    filteredOrders,
    metrics,
    isLoading,
    error,
    searchQuery,
    setSearchQuery,
    selectedStatus,
    setSelectedStatus,
    activeReceiptOrder,
    setActiveReceiptOrder,
    serverIsLive,
    lastUpdated,
    refreshData: fetchDashboardData,
    updateOrderStatus,
    deleteOrder,
  };
}

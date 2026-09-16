/**
 * React hooks for T3RMINAL storage
 * Uses event-based reactivity with host localStorage
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { readTable } from './host-storage';
import { onStorageChange } from './host-storage';
import { addSaleRecord, searchSales } from './database';
import type { SaleRecord, TransactionType } from './types';
import { useAccount } from '@/lib/web3';
import { normalizeToAssetHubAddress } from '@/lib/utils/address';
import { useAdminQrPayload } from '@/lib/config/admin-qr';

/**
 * Hook that re-fetches data when a table changes (replaces useLiveQuery)
 */
function useTableQuery<T>(table: string, query: () => Promise<T>, deps: any[] = []): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const result = await query();
      setData(result);
    } catch (err) {
      console.warn(`[Storage] Query failed for ${table}:`, err);
    }
  }, deps);

  useEffect(() => {
    refresh();
    return onStorageChange(table, refresh);
  }, [refresh, table]);

  return data;
}

/**
 * Hook to get sales history for the connected wallet
 */
export function useSalesHistory() {
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  // Resolve the "merchant identity" the same way the terminal page does
  // when it saves a sale — admin-configured payout address wins, otherwise
  // we fall back to the connected wallet. Without this match the listener
  // would store sales against one address (admin's) while history filtered
  // by another (connected wallet's), and the merchant would see an empty
  // history despite the toast saying "Sale saved to local storage".
  const merchantAddress = adminPayload?.receivingAddress ?? account?.address;
  const [searchTerm, setSearchTerm] = useState('');

  const allSales = useTableQuery<SaleRecord[]>(
    'sales',
    async () => {
      if (!merchantAddress) return [];

      const normalizedAddress = normalizeToAssetHubAddress(merchantAddress);
      const all = await readTable<SaleRecord>('sales');

      // Filter where user is merchant or customer
      const salesMap = new Map<string, SaleRecord>();
      all.forEach((sale) => {
        const isMerchant = sale.merchantAddressNormalized === normalizedAddress ||
                           sale.merchantAddress === normalizedAddress;
        const isCustomer = sale.customerAddressNormalized === normalizedAddress ||
                           sale.customerAddress === normalizedAddress;

        if (isMerchant) {
          salesMap.set(sale.saleId, { ...sale, type: 'incoming' as TransactionType });
        } else if (isCustomer && !salesMap.has(sale.saleId)) {
          salesMap.set(sale.saleId, { ...sale, type: 'outgoing' as TransactionType });
        }
      });

      return Array.from(salesMap.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    },
    [merchantAddress]
  );

  const filteredSales = useMemo(() => {
    if (!searchTerm.trim() || !allSales) return allSales || [];

    const term = searchTerm.toLowerCase();
    return allSales.filter(
      (sale) =>
        sale.customerName?.toLowerCase().includes(term) ||
        sale.customerAddress.toLowerCase().includes(term) ||
        sale.saleId.toLowerCase().includes(term) ||
        sale.merchantAddress.toLowerCase().includes(term) ||
        sale.amount.includes(term)
    );
  }, [allSales, searchTerm]);

  const groupedSales = useMemo(() => {
    if (!filteredSales) return {};

    const groups: Record<string, SaleRecord[]> = {};
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    filteredSales.forEach((sale) => {
      const saleDate = new Date(sale.timestamp);
      let dateKey: string;

      if (isSameDay(saleDate, today)) {
        dateKey = 'TODAY';
      } else if (isSameDay(saleDate, yesterday)) {
        dateKey = 'YESTERDAY';
      } else {
        dateKey = saleDate
          .toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: saleDate.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
          })
          .toUpperCase();
      }

      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(sale);
    });

    return groups;
  }, [filteredSales]);

  return {
    sales: filteredSales,
    groupedSales,
    searchTerm,
    setSearchTerm,
    isLoading: allSales === undefined,
    isEmpty: allSales?.length === 0,
  };
}

/**
 * Sum of today's incoming sales for the connected merchant, in planck.
 * Resolves the merchant identity the same way useSalesHistory does
 * (admin-configured payout address wins, connected wallet as fallback).
 * Sums exact bigint planck values — no float drift — and stays live via
 * the same storage-change subscription as the other hooks.
 */
export function useTodaysIncome() {
  const { account } = useAccount();
  const adminPayload = useAdminQrPayload();
  const merchantAddress = adminPayload?.receivingAddress ?? account?.address;

  const totalPlanck = useTableQuery<bigint>(
    'sales',
    async () => {
      if (!merchantAddress) return 0n;

      const normalizedAddress = normalizeToAssetHubAddress(merchantAddress);
      const all = await readTable<SaleRecord>('sales');
      const today = new Date();
      const seen = new Set<string>();
      let total = 0n;

      for (const sale of all) {
        const isMerchant = sale.merchantAddressNormalized === normalizedAddress ||
                           sale.merchantAddress === normalizedAddress;
        if (!isMerchant) continue;
        if (seen.has(sale.saleId)) continue;
        if (!isSameDay(new Date(sale.timestamp), today)) continue;
        // A coins claim the host later reverted is not income.
        if (sale.revertedAt) continue;
        seen.add(sale.saleId);
        try {
          total += BigInt(sale.amountPlanck);
        } catch {
          // Malformed legacy record — skip rather than poison the total.
        }
      }

      return total;
    },
    [merchantAddress]
  );

  return {
    totalPlanck: totalPlanck ?? 0n,
    isLoading: totalPlanck === undefined,
  };
}

/**
 * Hook to add a new sale record
 */
export function useAddSale() {
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addSale = useCallback(
    async (sale: Omit<SaleRecord, 'id' | 'createdAt' | 'syncStatus'>) => {
      setIsAdding(true);
      setError(null);

      try {
        const id = await addSaleRecord({
          ...sale,
          syncStatus: 'pending',
        });
        setIsAdding(false);
        return id;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to add sale';
        setError(message);
        setIsAdding(false);
        throw err;
      }
    },
    []
  );

  return { addSale, isAdding, error };
}

/**
 * Hook to get a specific sale by saleId
 */
export function useSale(saleId: string | null) {
  const sale = useTableQuery<SaleRecord | null>(
    'sales',
    async () => {
      if (!saleId) return null;
      const all = await readTable<SaleRecord>('sales');
      return all.find((s) => s.saleId === saleId) || null;
    },
    [saleId]
  );

  return { sale: sale ?? null, isLoading: sale === undefined };
}

/**
 * Hook for sync state
 */
export function useSyncState() {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const sync = useCallback(async () => {
    setIsSyncing(true);
    console.log('[Sync] Chain sync not implemented yet');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsSyncing(false);
    setLastSynced(new Date());
  }, []);

  return { isSyncing, lastSynced, sync };
}

function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

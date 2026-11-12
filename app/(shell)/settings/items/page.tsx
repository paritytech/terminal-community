"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Plus } from "lucide-react";
import {
  DEFAULT_TAX_RATE,
  DEFAULT_UNIT,
  ITEM_UNITS,
  TAX_RATES,
  deleteCheckoutItem,
  newCheckoutItemId,
  normalizePriceInput,
  upsertCheckoutItem,
  useCheckoutItems,
  type CheckoutItem,
} from "@/lib/config/checkout-items";
import { formatMoney } from "@/lib/utils/format";
import { useAssetSymbol } from "@/lib/utils/asset-metadata";

/**
 * Settings → Show Items in Checkout. The switch flips the terminal's entry
 * screen over to the item grid (Amount stays one tap away); below it the
 * merchant maintains the item list by hand — Back Office sync will take this
 * over in the multi-terminal upgrade. Editing happens in-page: tapping a row
 * (or Add item) swaps the list for the form from the design.
 */

// null → list view; "new" → blank form; otherwise the item being edited.
type Editing = CheckoutItem | "new" | null;

export default function CheckoutItemsSettingsPage() {
  const { enabled, items, isLoading, setEnabled } = useCheckoutItems();
  const symbol = useAssetSymbol();
  const [editing, setEditing] = useState<Editing>(null);

  if (editing !== null) {
    return (
      <ItemEditor
        item={editing === "new" ? null : editing}
        symbol={symbol}
        onClose={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4 shrink-0">
          <Link href="/settings" className="p-2" aria-label="Back to settings">
            <ArrowLeft className="w-6 h-6 text-white" />
          </Link>
          <span className="text-white text-lg font-semibold">Items in Checkout</span>
          <div className="w-10" />
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {/* Master switch */}
          <div className="flex items-center justify-between gap-4 bg-neutral-900 rounded-2xl p-5">
            <span className="text-white text-lg font-semibold">
              Show Items in Checkout
            </span>
            <button
              role="switch"
              aria-label="Show Items in Checkout"
              aria-checked={enabled === true}
              disabled={isLoading}
              onClick={() => void setEnabled(!(enabled === true))}
              className={`relative w-12 h-7 rounded-full shrink-0 transition-colors disabled:opacity-40 ${
                enabled ? "bg-[#4353ff]" : "bg-neutral-700"
              }`}
            >
              <span
                className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white transition-transform ${
                  enabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
          <p className="text-neutral-500 text-sm mt-3 px-1">
            When on, Check out opens with your items list — the amount keypad
            stays one tap away.
          </p>

          {/* Item list */}
          <div className="flex items-center justify-between mt-8 mb-2">
            <h2 className="text-white text-lg font-semibold">Items</h2>
            <button
              onClick={() => setEditing("new")}
              className="flex items-center gap-1.5 bg-white hover:bg-neutral-100 text-black text-sm font-semibold px-4 py-2 rounded-full transition"
            >
              <Plus className="w-4 h-4" />
              Add item
            </button>
          </div>

          {items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-neutral-800 p-6 text-center mt-2">
              <p className="text-neutral-500 text-sm">
                No items yet. Add the products you sell and they&apos;ll show up
                as a grid in Check out.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-800">
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setEditing(item)}
                  className="w-full flex items-center gap-4 py-4 text-left hover:bg-neutral-900 rounded-xl px-2 -mx-2 transition"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-white font-medium truncate">
                      {item.name}
                    </span>
                    <span className="block text-neutral-500 text-sm mt-0.5">
                      {item.unit} · {item.taxRate}% tax
                    </span>
                  </span>
                  <span className="text-white font-semibold shrink-0">
                    {formatMoney(item.price)} {symbol}
                  </span>
                  <ChevronRight className="w-5 h-5 text-neutral-500 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/** Add/edit form per the design: Name, Price (incl. Tax), Unit, Tax rate. */
function ItemEditor({
  item,
  symbol,
  onClose,
}: {
  item: CheckoutItem | null;
  symbol: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [price, setPrice] = useState(item?.price ?? "");
  const [unit, setUnit] = useState(item?.unit ?? DEFAULT_UNIT);
  const [taxRate, setTaxRate] = useState(item?.taxRate ?? DEFAULT_TAX_RATE);
  const [saving, setSaving] = useState(false);

  const normalizedPrice = normalizePriceInput(price);
  const canSave = name.trim().length > 0 && normalizedPrice !== null && !saving;

  const handleSave = async () => {
    if (!canSave || normalizedPrice === null) return;
    setSaving(true);
    try {
      await upsertCheckoutItem({
        id: item?.id ?? newCheckoutItemId(),
        name: name.trim(),
        price: normalizedPrice,
        unit,
        taxRate,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!item || saving) return;
    setSaving(true);
    try {
      await deleteCheckoutItem(item.id);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-1 min-h-0 flex flex-col max-w-md mx-auto w-full">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-4 shrink-0">
          <button onClick={onClose} className="p-2" aria-label="Back to items">
            <ArrowLeft className="w-6 h-6 text-white" />
          </button>
          <span className="text-white text-lg font-semibold">
            {item ? "Edit Item" : "Add Item"}
          </span>
          <div className="w-10" />
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto px-6 py-4 flex flex-col">
          <div className="space-y-5">
            {/* Name */}
            <div>
              <label htmlFor="item-name" className="block text-neutral-400 text-sm mb-2">
                Name
              </label>
              <input
                id="item-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={40}
                placeholder="e.g. Cappuccino"
                className="w-full rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-4 text-white text-lg outline-none placeholder:text-neutral-600 focus:border-neutral-600"
              />
            </div>

            {/* Price incl. tax */}
            <div>
              <label htmlFor="item-price" className="block text-neutral-400 text-sm mb-2">
                Price (incl. Tax)
              </label>
              <div className="flex items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-4 focus-within:border-neutral-600">
                <span className="text-neutral-500 text-lg shrink-0">{symbol}</span>
                <input
                  id="item-price"
                  value={price}
                  onChange={(e) =>
                    setPrice(e.target.value.replace(/[^\d.,]/g, "").slice(0, 12))
                  }
                  inputMode="decimal"
                  placeholder="0.00"
                  className="w-full bg-transparent text-white text-lg outline-none placeholder:text-neutral-600"
                />
              </div>
            </div>

            {/* Unit */}
            <SelectField
              id="item-unit"
              label="Unit"
              value={unit}
              onChange={setUnit}
              options={ITEM_UNITS.map((u) => ({ value: u, label: u }))}
            />

            {/* Tax rate */}
            <SelectField
              id="item-tax"
              label="Tax rate"
              value={String(taxRate)}
              onChange={(v) => setTaxRate(Number(v))}
              options={TAX_RATES.map((r) => ({ value: String(r), label: `${r}%` }))}
            />
          </div>

          <div className="flex-1 min-h-6" />

          {item && (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="w-full text-red-500 hover:text-red-400 font-medium py-3 transition disabled:opacity-50"
            >
              Remove item
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="w-full bg-white hover:bg-neutral-100 disabled:bg-neutral-800 disabled:text-neutral-500 text-black font-semibold py-4 rounded-xl transition text-lg"
          >
            Save
          </button>
        </main>
      </div>
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-neutral-400 text-sm mb-2">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none rounded-xl border border-neutral-800 bg-neutral-950 px-4 py-4 pr-11 text-white text-lg outline-none focus:border-neutral-600"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-neutral-950">
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500" />
      </div>
    </div>
  );
}

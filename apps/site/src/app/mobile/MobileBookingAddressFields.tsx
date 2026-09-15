"use client";

import React from "react";
import { formatPropertyAddress } from "@/lib/property-address";

type BookingProperty = {
  id: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  postalCode: string;
};

type Props = {
  properties: BookingProperty[];
  detectedAddress?: Omit<BookingProperty, "id"> | null;
};

const fieldClassName =
  "mt-1 w-full rounded-md border border-white/10 bg-slate-900 px-3 py-2 text-base text-white outline-none focus:border-cyan-300";
const labelClassName = "text-xs font-semibold text-slate-400";

export function MobileBookingAddressFields({
  properties,
  detectedAddress = null,
}: Props): React.ReactElement {
  const [propertyId, setPropertyId] = React.useState(properties[0]?.id ?? "");
  const isNewAddress = !propertyId;

  return (
    <>
      {properties.length ? (
        <label className="block">
          <span className="text-xs font-semibold text-slate-300">Property</span>
          <select
            name="propertyId"
            value={propertyId}
            onChange={(event) => setPropertyId(event.target.value)}
            className="mt-1 w-full rounded-md border border-white/10 bg-slate-950 px-3 py-2 text-base text-white outline-none focus:border-cyan-300"
          >
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {formatPropertyAddress(property)}
              </option>
            ))}
            <option value="">Add a new address</option>
          </select>
          <span className="mt-1 block text-xs leading-5 text-slate-400">
            Choose add new to book a different address, unit, or building.
          </span>
        </label>
      ) : (
        <input type="hidden" name="propertyId" value="" />
      )}
      <fieldset
        hidden={!isNewAddress}
        disabled={!isNewAddress}
        className="rounded-md border border-white/10 bg-slate-950 p-3"
      >
        <legend className="text-xs font-semibold text-slate-300">
          Add new address
        </legend>
        {detectedAddress ? (
          <p className="mt-1 text-xs leading-5 text-cyan-100">
            Found in the thread and prefilled for faster new-address booking.
          </p>
        ) : null}
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className={labelClassName}>Street</span>
            <input
              name="addressLine1"
              defaultValue={detectedAddress?.addressLine1 ?? ""}
              required={isNewAddress}
              className={fieldClassName}
              placeholder="123 Main St"
            />
          </label>
          <label className="block">
            <span className={labelClassName}>Unit / building</span>
            <input
              name="addressLine2"
              defaultValue={detectedAddress?.addressLine2 ?? ""}
              className={fieldClassName}
              placeholder="Building B, Unit 204"
            />
          </label>
          <div className="grid grid-cols-[1fr_4rem_6rem] gap-2">
            <label className="block">
              <span className={labelClassName}>City</span>
              <input
                name="city"
                defaultValue={detectedAddress?.city ?? ""}
                required={isNewAddress}
                className={fieldClassName}
              />
            </label>
            <label className="block">
              <span className={labelClassName}>State</span>
              <input
                name="state"
                defaultValue={detectedAddress?.state ?? "GA"}
                maxLength={2}
                required={isNewAddress}
                className={`${fieldClassName} uppercase`}
              />
            </label>
            <label className="block">
              <span className={labelClassName}>ZIP</span>
              <input
                name="postalCode"
                defaultValue={detectedAddress?.postalCode ?? ""}
                inputMode="numeric"
                required={isNewAddress}
                className={fieldClassName}
              />
            </label>
          </div>
        </div>
      </fieldset>
    </>
  );
}

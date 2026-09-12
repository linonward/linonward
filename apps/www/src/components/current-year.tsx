"use client";

export function CurrentYear() {
  const year = new Date().getFullYear();

  return (
    <time dateTime={String(year)} suppressHydrationWarning>
      {year}
    </time>
  );
}

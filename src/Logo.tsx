import type { SVGProps } from 'react';

/** Schematic LED: a diode with two arrows showing emitted light. */
export default function Logo({ size = 24, strokeWidth = 2, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M3 16h4m8 0h6M7 11v10l8-5-8-5Zm8 0v10" />
    <path d="m10 8 4-4m-3 0h3v3m2 2 4-4m-3 0h3v3" />
  </svg>;
}

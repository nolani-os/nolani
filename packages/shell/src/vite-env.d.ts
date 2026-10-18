/// <reference types="vite/client" />

// vite-plugin-svgr — `import X from "./icon.svg?react"` returns a React component
declare module "*.svg?react" {
  import type { ComponentType, SVGProps } from "react";
  const Component: ComponentType<SVGProps<SVGSVGElement>>;
  export default Component;
}

// Vite asset URL imports
declare module "*.svg?url" {
  const src: string;
  export default src;
}

declare module "*.css?url" {
  const src: string;
  export default src;
}

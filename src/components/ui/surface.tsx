import type { ComponentPropsWithRef } from "react";
import { mergeClassNames } from "@/components/ui/class-names";
import styles from "@/components/ui/foundations.module.css";

export type SurfaceElevation = "default" | "raised" | "soft" | "flat";
export type SurfacePadding = "none" | "compact" | "default";

export type SurfaceProps = ComponentPropsWithRef<"div"> & {
  elevation?: SurfaceElevation;
  padding?: SurfacePadding;
};

const elevationClassName: Record<SurfaceElevation, string> = {
  default: styles.surfaceDefault,
  flat: styles.surfaceFlat,
  raised: styles.surfaceRaised,
  soft: styles.surfaceSoft,
};

const paddingClassName: Record<SurfacePadding, string> = {
  compact: styles.surfacePaddingCompact,
  default: styles.surfacePaddingDefault,
  none: styles.surfacePaddingNone,
};

export function Surface({
  className,
  elevation = "default",
  padding = "default",
  ref,
  ...nativeProps
}: SurfaceProps) {
  return (
    <div
      {...nativeProps}
      className={mergeClassNames(
        styles.surface,
        elevationClassName[elevation],
        paddingClassName[padding],
        className,
      )}
      data-nl-ui="surface"
      ref={ref}
    />
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "@/components/ui/button";

/** The one bar under the page header. `title` and `children` sit on the left, `actions` on the right. */
export function PageToolbar({ title, actions, children, className }: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("page-toolbar", className)}>
    {title && <span className="toolbar-title">{title}</span>}
    {children}
    {actions && <div className="toolbar-end">{actions}</div>}
  </div>;
}

/** A toolbar button that shows a panel or mode. It is tinted while on, so on and off are never ambiguous. */
export function ToolbarToggle({ pressed, className, ...props }: Omit<ButtonProps, "variant" | "size" | "aria-pressed"> & { pressed: boolean }) {
  return <Button size="sm" variant="ghost" aria-pressed={pressed} className={cn("toolbar-toggle", className)} {...props} />;
}

/** A column beside a page's main area: one width, one border, one header height. */
export function SidePanel({ label, header, side = "left", className, children, ...props }: Omit<React.HTMLAttributes<HTMLElement>, "title"> & {
  label: string;
  header?: React.ReactNode;
  side?: "left" | "right";
}) {
  return <aside aria-label={label} className={cn("side-panel", side === "right" && "is-right", className)} {...props}>
    {header && <div className="side-panel-header">{header}</div>}
    {children}
  </aside>;
}
export function PageHeader({ title, description, actions, heading: Heading = "h1" }: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  heading?: "h1" | "h2";
}) {
  return <header className="page-header"><div className="min-w-0"><Heading className="page-title">{title}</Heading>{description && <p className="page-description">{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function PromptComposer({ children, controls, caption, notice, className, ...props }: React.HTMLAttributes<HTMLDivElement> & {
  controls: React.ReactNode;
  caption?: React.ReactNode;
  notice?: React.ReactNode;
}) {
  return <div className={cn("composer-dock", className)}>
    {notice}
    <div className="prompt-composer" {...props}>
      <div className="prompt-composer-content">{children}</div>
      <div className="prompt-composer-controls">{controls}</div>
    </div>
    {caption && <div className="prompt-composer-caption">{caption}</div>}
  </div>;
}

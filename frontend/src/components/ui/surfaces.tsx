import * as React from "react";
import { cn } from "@/lib/utils";

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

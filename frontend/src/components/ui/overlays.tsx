/* Radix overlays in shadcn style: Dialog, AlertDialog, Popover, Tooltip, DropdownMenu, ContextMenu, Select, Tabs, ScrollArea. */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as AlertPrimitive from "@radix-ui/react-alert-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as ContextPrimitive from "@radix-ui/react-context-menu";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as ScrollPrimitive from "@radix-ui/react-scroll-area";
import { Check, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "./button";

const overlayCls = "fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";
const contentAnim = "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95";

// ---------------- Dialog
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }>(
  ({ className, children, hideClose, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={overlayCls} />
      <DialogPrimitive.Content ref={ref} className={cn("fixed left-1/2 top-1/2 z-50 grid max-h-[90vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-hidden rounded-xl border bg-elevated p-5 shadow-2xl duration-200", contentAnim, className)} {...props}>
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = "DialogContent";
export const DialogHeader = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("space-y-1 pr-6", className)} {...p} />;
export const DialogFooter = ({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div className={cn("flex justify-end gap-2", className)} {...p} />;
export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>(({ className, ...p }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold", className)} {...p} />
));
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = React.forwardRef<HTMLParagraphElement, React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>(({ className, ...p }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...p} />
));
DialogDescription.displayName = "DialogDescription";

// ---------------- Confirm (AlertDialog)
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", destructive, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: React.ReactNode; confirmLabel?: string; destructive?: boolean; onConfirm: () => void;
}) {
  return (
    <AlertPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertPrimitive.Portal>
        <AlertPrimitive.Overlay className={overlayCls} />
        <AlertPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 grid w-full max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-elevated p-5 shadow-2xl", contentAnim)}>
          <AlertPrimitive.Title className="text-base font-semibold">{title}</AlertPrimitive.Title>
          {description && <AlertPrimitive.Description className="text-sm text-muted-foreground">{description}</AlertPrimitive.Description>}
          <div className="flex justify-end gap-2">
            <AlertPrimitive.Cancel className={buttonVariants({ variant: "ghost", size: "sm" })}>Cancel</AlertPrimitive.Cancel>
            <AlertPrimitive.Action className={buttonVariants({ variant: destructive ? "destructive" : "default", size: "sm" })} onClick={onConfirm}>{confirmLabel}</AlertPrimitive.Action>
          </div>
        </AlertPrimitive.Content>
      </AlertPrimitive.Portal>
    </AlertPrimitive.Root>
  );
}

// ---------------- Popover
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverContent = React.forwardRef<React.ElementRef<typeof PopoverPrimitive.Content>, React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>>(
  ({ className, align = "center", sideOffset = 6, ...props }, ref) => (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content ref={ref} align={align} sideOffset={sideOffset} className={cn("z-50 rounded-lg border bg-popover p-3 text-popover-foreground shadow-xl outline-none", contentAnim, "data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2", className)} {...props} />
    </PopoverPrimitive.Portal>
  ),
);
PopoverContent.displayName = "PopoverContent";

// ---------------- Tooltip
export const TooltipProvider = TooltipPrimitive.Provider;
export function Tip({ content, children, side = "top", delay = 300 }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right"; delay?: number }) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root delayDuration={delay}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={6} className={cn("z-[60] max-w-xs rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg", contentAnim)}>
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---------------- Dropdown
export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuContent = React.forwardRef<React.ElementRef<typeof DropdownPrimitive.Content>, React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn("z-50 min-w-[10rem] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl", contentAnim, className)} {...props} />
    </DropdownPrimitive.Portal>
  ),
);
DropdownMenuContent.displayName = "DropdownMenuContent";
const itemCls = "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted-foreground";
export const DropdownMenuItem = React.forwardRef<React.ElementRef<typeof DropdownPrimitive.Item>, React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { destructive?: boolean }>(
  ({ className, destructive, ...props }, ref) => <DropdownPrimitive.Item ref={ref} className={cn(itemCls, destructive && "text-destructive focus:bg-destructive/10 [&_svg]:text-destructive", className)} {...props} />,
);
DropdownMenuItem.displayName = "DropdownMenuItem";
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Label>) => <DropdownPrimitive.Label className={cn("px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground", className)} {...p} />;
export const DropdownMenuSeparator = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Separator>) => <DropdownPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...p} />;

// ---------------- Context menu
export const ContextMenu = ContextPrimitive.Root;
export const ContextMenuTrigger = ContextPrimitive.Trigger;
export const ContextMenuContent = React.forwardRef<React.ElementRef<typeof ContextPrimitive.Content>, React.ComponentPropsWithoutRef<typeof ContextPrimitive.Content>>(({ className, ...props }, ref) => (
  <ContextPrimitive.Portal>
    <ContextPrimitive.Content ref={ref} className={cn("z-50 min-w-[12rem] overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl", contentAnim, className)} {...props} />
  </ContextPrimitive.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";
export const ContextMenuItem = React.forwardRef<React.ElementRef<typeof ContextPrimitive.Item>, React.ComponentPropsWithoutRef<typeof ContextPrimitive.Item> & { destructive?: boolean }>(
  ({ className, destructive, ...props }, ref) => <ContextPrimitive.Item ref={ref} className={cn(itemCls, destructive && "text-destructive focus:bg-destructive/10", className)} {...props} />,
);
ContextMenuItem.displayName = "ContextMenuItem";
export const ContextMenuSeparator = () => <ContextPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
export const ContextMenuLabel = ({ children }: { children: React.ReactNode }) => <ContextPrimitive.Label className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</ContextPrimitive.Label>;
export const ContextMenuSub = ContextPrimitive.Sub;
export const ContextMenuSubTrigger = ({ children }: { children: React.ReactNode }) => <ContextPrimitive.SubTrigger className={itemCls}>{children}</ContextPrimitive.SubTrigger>;
export const ContextMenuSubContent = ({ children }: { children: React.ReactNode }) => (
  <ContextPrimitive.Portal><ContextPrimitive.SubContent className="z-50 max-h-80 min-w-[12rem] overflow-auto rounded-lg border bg-popover p-1 shadow-xl">{children}</ContextPrimitive.SubContent></ContextPrimitive.Portal>
);

// ---------------- Select
export function Select({ value, onValueChange, options, placeholder, className, disabled, ariaLabel }: {
  value: string; onValueChange: (v: string) => void; options: { value: string; label: React.ReactNode; hint?: string }[]; placeholder?: string; className?: string; disabled?: boolean; ariaLabel?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger aria-label={ariaLabel} className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 [&>span]:truncate", className)}>
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon><ChevronDown className="h-4 w-4 opacity-50" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className={cn("z-[70] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border bg-popover shadow-xl", contentAnim)}>
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="relative flex cursor-default select-none flex-col rounded-md py-1.5 pl-7 pr-2 text-sm outline-none focus:bg-accent data-[disabled]:opacity-50">
                <SelectPrimitive.ItemIndicator className="absolute left-2 top-2"><Check className="h-3.5 w-3.5 text-primary" /></SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                {o.hint && <span className="text-[11px] text-muted-foreground">{o.hint}</span>}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

// ---------------- Tabs
export const Tabs = TabsPrimitive.Root;
export const TabsList = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) => (
  <TabsPrimitive.List className={cn("inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 text-muted-foreground", className)} {...p} />
);
export const TabsTrigger = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>) => (
  <TabsPrimitive.Trigger className={cn("inline-flex h-7 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition-all hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm [&_svg]:size-3.5", className)} {...p} />
);
export const TabsContent = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>) => (
  <TabsPrimitive.Content className={cn("focus-visible:outline-none data-[state=active]:animate-fade-up", className)} {...p} />
);

// ---------------- ScrollArea
export const ScrollArea = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<typeof ScrollPrimitive.Root> & { viewportRef?: React.Ref<HTMLDivElement>; onViewportScroll?: React.UIEventHandler<HTMLDivElement> }>(
  ({ className, children, viewportRef, onViewportScroll, ...props }, ref) => (
    <ScrollPrimitive.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollPrimitive.Viewport ref={viewportRef} onScroll={onViewportScroll} className="h-full w-full rounded-[inherit] [&>div]:!block">{children}</ScrollPrimitive.Viewport>
      <ScrollPrimitive.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-px transition-colors">
        <ScrollPrimitive.Thumb className="relative flex-1 rounded-full bg-border hover:bg-muted-foreground/40" />
      </ScrollPrimitive.Scrollbar>
      <ScrollPrimitive.Corner />
    </ScrollPrimitive.Root>
  ),
);
ScrollArea.displayName = "ScrollArea";

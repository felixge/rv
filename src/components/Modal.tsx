import type { HTMLAttributes, ReactNode } from "react";

// A dialog over a backdrop that closes it. With onSubmit, the dialog is a form.
export function Modal({
  onClose,
  onSubmit,
  backdropClassName = "",
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "onSubmit"> & {
  onClose: () => void;
  onSubmit?: () => void;
  backdropClassName?: string;
  children: ReactNode;
}) {
  const dialog = { role: "dialog", "aria-modal": true, ...props };
  return (
    <div
      className={`modal-backdrop ${backdropClassName}`.trim()}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {onSubmit ? (
        <form
          {...dialog}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {children}
        </form>
      ) : (
        <section {...dialog}>{children}</section>
      )}
    </div>
  );
}

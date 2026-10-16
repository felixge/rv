import { splitProps, type JSX } from "solid-js";

// A dialog over a backdrop that closes it. With onSubmit, the dialog is a form.
export function Modal(
  props: Omit<JSX.HTMLAttributes<HTMLElement>, "onSubmit"> & {
    onClose: () => void;
    onSubmit?: () => void;
    backdropClass?: string;
    children: JSX.Element;
  },
) {
  const [local, dialog] = splitProps(props, ["onClose", "onSubmit", "backdropClass", "children"]);
  return (
    <div
      class={`modal-backdrop ${local.backdropClass || ""}`.trim()}
      onClick={(event) => {
        if (event.target === event.currentTarget) local.onClose();
      }}
    >
      {local.onSubmit ? (
        <form
          role="dialog"
          aria-modal="true"
          {...(dialog as JSX.HTMLAttributes<HTMLFormElement>)}
          onSubmit={(event) => {
            event.preventDefault();
            local.onSubmit!();
          }}
        >
          {local.children}
        </form>
      ) : (
        <section role="dialog" aria-modal="true" {...dialog}>{local.children}</section>
      )}
    </div>
  );
}

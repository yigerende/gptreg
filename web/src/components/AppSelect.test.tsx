import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from 'radix-ui';
import { afterEach, expect, it, vi } from 'vitest';

import { AppSelect } from './AppSelect';

const OPTIONS = [
  { value: 'random', label: 'Random domains' },
  { value: 'selected', label: 'Selected domains' },
];

function renderInDialog(props: Partial<Parameters<typeof AppSelect>[0]> = {}) {
  const changed = vi.fn();
  render(
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <Dialog.Title>Mail settings</Dialog.Title>
          <Dialog.Description>Choose an alias policy</Dialog.Description>
          <AppSelect ariaLabel="Alias domain policy" value="random" onValueChange={changed} options={OPTIONS} {...props} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>,
  );
  fireEvent.click(screen.getByRole('combobox', { name: 'Alias domain policy' }));
  return changed;
}

const listeners: Array<[string, EventListener]> = [];
function spyOnDocument(type: string) {
  const listener = vi.fn();
  document.addEventListener(type, listener);
  listeners.push([type, listener]);
  return listener;
}

afterEach(() => {
  while (listeners.length) {
    const [type, listener] = listeners.pop()!;
    document.removeEventListener(type, listener);
  }
});

it('keeps a portalled menu clickable inside a modal dialog', () => {
  const changed = renderInDialog();

  fireEvent.pointerDown(screen.getByRole('option', { name: 'Selected domains' }));
  fireEvent.click(screen.getByRole('option', { name: 'Selected domains' }));

  expect(changed).toHaveBeenCalledWith('selected');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

// A modal dialog sets `pointer-events: none` on <body>, and DismissableLayer.Branch does not undo it,
// so the menu's own host has to re-enable pointer events or every option click misses the menu.
it('re-enables pointer events on the menu host while the dialog disables the body', () => {
  renderInDialog();

  expect(document.body.style.pointerEvents).toBe('none');
  const host = document.querySelector<HTMLElement>('[data-app-select-portal]');
  expect(host).not.toBeNull();
  expect(host!.style.pointerEvents).toBe('auto');
  expect(host!.contains(screen.getByRole('option', { name: 'Selected domains' }))).toBe(true);
});

// The dialog's focus scope re-focuses itself on any document-level `focusin` from outside the dialog,
// which would kick the caret straight back out of the menu's search box.
it('hides menu focus and scrolling from the dialog focus scope and scroll lock', () => {
  renderInDialog({ searchable: true });
  const focusIn = spyOnDocument('focusin');
  const wheel = spyOnDocument('wheel');
  const keyDown = spyOnDocument('keydown');

  const search = screen.getByRole('textbox', { name: 'Alias domain policy搜索' });
  fireEvent.focusIn(search);
  fireEvent.wheel(screen.getByRole('listbox', { name: 'Alias domain policy选项' }));
  fireEvent.keyDown(search, { key: 'ArrowDown' });

  expect(focusIn).not.toHaveBeenCalled();
  expect(wheel).not.toHaveBeenCalled();
  expect(keyDown).not.toHaveBeenCalled();
});

// Escape belongs to whichever layer is on top: it should close the menu and leave the dialog open.
it('closes only the menu on Escape', () => {
  renderInDialog();

  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Alias domain policy' }), { key: 'Escape' });

  expect(screen.queryByRole('option', { name: 'Selected domains' })).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(document.querySelector('[data-app-select-portal]')).toBeNull();
});

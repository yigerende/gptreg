import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { ConfigNumberInput } from './ConsoleUi';

it('keeps number-wheel changes inside the input', () => {
  const changed = vi.fn();
  const { container } = render(
    <div data-testid="scroll-parent">
      <ConfigNumberInput aria-label="数量" min={1} max={5} value={2} onValueChange={changed} />
    </div>,
  );
  const parent = container.firstElementChild as HTMLDivElement;
  const bubbled = vi.fn();
  parent.addEventListener('wheel', bubbled);
  const input = screen.getByRole('spinbutton', { name: '数量' });

  input.focus();
  const focusedWheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
  fireEvent(input, focusedWheel);

  expect(focusedWheel.defaultPrevented).toBe(true);
  expect(bubbled).not.toHaveBeenCalled();
  expect(changed).toHaveBeenLastCalledWith(3);
  expect(input).toHaveValue(3);

});

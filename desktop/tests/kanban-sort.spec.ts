import { test, expect } from '@playwright/test';

import { compareKanbanTasks, type TaskItem } from '../src/lib/tasks';

// Only the fields the comparator reads matter here.
const task = (id: number, priority: TaskItem['priority'], deadline: string | null) =>
  ({ id, title: `Task ${id}`, priority, deadline }) as TaskItem;

const order = (tasks: TaskItem[]) => [...tasks].sort(compareKanbanTasks).map((t) => t.id);

test('a more pressing priority sorts first, whatever the due dates', () => {
  expect(order([task(1, 'normal', '2026-10-01'), task(2, 'urgent', '2026-12-01'), task(3, 'low', null), task(4, 'high', null)])).toEqual([
    2, 4, 1, 3,
  ]);
});

test('within a priority the sooner due date sorts first', () => {
  expect(order([task(1, 'normal', '2026-10-25'), task(2, 'normal', '2026-10-19')])).toEqual([2, 1]);
});

test('within a priority a task with a due date sorts before one without', () => {
  expect(order([task(1, 'normal', null), task(2, 'normal', '2026-10-30')])).toEqual([2, 1]);
});

test('within a priority and due date the lower id sorts first', () => {
  expect(order([task(3, 'normal', null), task(1, 'normal', null), task(2, 'normal', null)])).toEqual([1, 2, 3]);
  expect(order([task(5, 'high', '2026-10-20'), task(4, 'high', '2026-10-20')])).toEqual([4, 5]);
});

test('the manual test scenario: urgent first, then Normal by due date, undated last', () => {
  const a = task(1, 'normal', '2026-10-30');
  const b = task(2, 'normal', '2026-10-20');
  const c = task(3, 'normal', null);
  const urgent = task(4, 'urgent', '2026-10-29');
  expect(order([a, b, c, urgent])).toEqual([4, 2, 1, 3]);
});

// @vitest-environment jsdom
// A course's assessments as tables (the owner, 2026-11-24): type first, no objective; a CLO added to an assessment brings the rubric
// template of its type; shares split evenly until changed; what each CLO is worth; a new row is not flagged until it is left.
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_ACHIEVEMENT_SCALE, DEFAULT_OUTCOME_LEVELS, DEFAULT_RUBRIC_TEMPLATES, DEFAULT_SYLLABUS_SETTINGS, checkSyllabus, emptySyllabus, type SyllabusContent,
} from '@ams/shared';
import { AssessmentPlan } from './components/syllabus/assessment-plan';

function Harness({ start }: { start: SyllabusContent }) {
  const [c, setC] = useState(start);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const issues = checkSyllabus(c, { settings: DEFAULT_SYLLABUS_SETTINGS, levels: DEFAULT_OUTCOME_LEVELS, scale: DEFAULT_ACHIEVEMENT_SCALE });
  return (
    <>
      <AssessmentPlan content={c} onChange={setC} scale={DEFAULT_ACHIEVEMENT_SCALE} templates={DEFAULT_RUBRIC_TEMPLATES} settings={DEFAULT_SYLLABUS_SETTINGS}
        issues={issues} fresh={fresh} onFresh={(id, on) => setFresh((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; })} />
      <button type="button">Elsewhere</button>
    </>
  );
}

afterEach(cleanup);

const withClos = () => {
  const c = emptySyllabus();
  c.clos = [1, 2, 3].map((n) => ({ id: `c${n}`, code: `CLO${n}`, textEn: `Outcome ${n}`, textAr: '', bloom: 'apply', plos: [] }));
  return c;
};

describe('the assessments tables', () => {
  it('adds an assessment quietly, brings the template rubric with each CLO, splits the shares evenly, and says what each CLO is worth', async () => {
    const user = userEvent.setup();
    render(<Harness start={withClos()} />);
    expect(within(screen.getByRole('table', { name: 'Assessments' })).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['', 'Type', 'Assessment', 'Week', 'Weight %', '']);
    await user.click(screen.getByRole('button', { name: '+ Assessment' }));
    // Just added: no complaints yet.
    expect(screen.queryByRole('list', { name: /Issues of/ })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assessment 1 type' }), 'midterm');
    await user.type(screen.getByRole('textbox', { name: 'Assessment 1 name' }), 'Midterm');
    await user.type(screen.getByRole('textbox', { name: 'Assessment 1 weight' }), '100');
    await user.click(screen.getByRole('button', { name: '+ CLO' }));
    expect((screen.getByRole('combobox', { name: 'CLO1 rubric in assessment 1' }) as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Exam or quiz question');
    await user.click(screen.getByRole('button', { name: '+ CLO' }));
    expect((screen.getByRole('textbox', { name: 'CLO1 share of assessment 1' }) as HTMLInputElement).value).toBe('50');
    expect((screen.getByRole('textbox', { name: 'CLO2 share of assessment 1' }) as HTMLInputElement).value).toBe('50');
    expect(screen.getByTestId('weight-total').textContent).toBe('100% ✓');
    const worth = screen.getAllByTestId('clo-worth').map((r) => r.textContent);
    expect(worth[0]).toMatch(/CLO150%Midterm✓/);
    expect(worth[2]).toMatch(/CLO3—.*Not assessed/);
    // One rubric for the course, from the template, used by both CLOs.
    expect(screen.getAllByTestId('course-rubric')).toHaveLength(1);
    expect(screen.getByTestId('course-rubric').textContent).toContain('Midterm · CLO1; Midterm · CLO2');
    // Leaving the row lets its issues show.
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByText(/has no due week/)).not.toBeNull();
  });

  it('edits a rubric at the institution\'s levels, which a coordinator cannot change', async () => {
    const user = userEvent.setup();
    render(<Harness start={withClos()} />);
    await user.click(screen.getByRole('button', { name: '+ Assessment' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Assessment 1 type' }), 'project');
    await user.click(screen.getByRole('button', { name: '+ CLO' }));
    await user.click(within(screen.getByTestId('course-rubric')).getByRole('button', { name: 'Edit' }));
    const grid = screen.getByRole('table', { name: 'Criteria of the rubric' });
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Criterion', 'Exemplary', 'Proficient', 'Developing', 'Beginning', '']);
    await user.clear(screen.getByRole('textbox', { name: 'Rubric title' }));
    await user.type(screen.getByRole('textbox', { name: 'Rubric title' }), 'Capstone design');
    await user.click(screen.getByRole('button', { name: 'Save rubric' }));
    expect(screen.getByTestId('course-rubric').textContent).toContain('Capstone design');
    expect(screen.getByTestId('course-rubric').textContent).toContain('Project or report');
  });
});

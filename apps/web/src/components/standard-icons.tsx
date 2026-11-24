import { useMemo, useState } from 'react';
import {
  Accessibility, Activity, Archive, Atom, Award, BadgeCheck, Banknote, Blocks, BookOpen, BookOpenCheck, Bot, Boxes, Brain, Briefcase, Building, Building2,
  Bus, Calendar, CalendarCheck, ChartColumn, ChartLine, ChartPie, CircleCheck, ClipboardCheck, ClipboardList, Clock, Coins, Compass, Cpu, Database,
  Dumbbell, Eye, FileStack, FileText, Files, Flag, FlaskConical, FolderOpen, Gauge, Gavel, GitBranch, Globe, GraduationCap, HandHeart, Handshake, Heart,
  HeartHandshake, House, Inbox, KeyRound, Landmark, Languages, Laptop, Layers, LayoutGrid, Leaf, Library, Lightbulb, ListChecks, ListTree, Mail, Map,
  MapPin, Medal, Megaphone, MessageSquare, MessagesSquare, Microscope, Milestone, Monitor, Music, Network, NotebookPen, Palette, PenTool, PiggyBank,
  Presentation, Puzzle, Recycle, RefreshCcw, Repeat, Rocket, Route, Scale, School, ScrollText, Search, Server, Settings2, ShieldCheck, Signpost, Smile,
  Sparkles, Sprout, Star, Stethoscope, Target, Telescope, Timer, TrendingUp, Trophy, UserCheck, Users, UsersRound, Utensils, Wallet, Workflow, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react';
import { Dialog } from './dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';

/**
 * The icons a top-level standard can show (Quality Management's side panel). A curated set of lucide icons, so the page does not
 * carry the whole library; the name is what is stored (requirement_icon.icon). Words are the search terms besides the name.
 */
export const STANDARD_ICONS: Record<string, { icon: LucideIcon; words: string }> = {
  Target: { icon: Target, words: 'goal mission objective' }, Flag: { icon: Flag, words: 'mission milestone' }, Compass: { icon: Compass, words: 'vision direction strategy' },
  Signpost: { icon: Signpost, words: 'direction strategy' }, Route: { icon: Route, words: 'plan path strategy' }, Milestone: { icon: Milestone, words: 'plan progress' },
  Telescope: { icon: Telescope, words: 'vision future' }, Rocket: { icon: Rocket, words: 'innovation launch' }, Lightbulb: { icon: Lightbulb, words: 'idea innovation' },
  Landmark: { icon: Landmark, words: 'governance institution' }, Gavel: { icon: Gavel, words: 'governance law policy' }, Scale: { icon: Scale, words: 'ethics integrity law' },
  ScrollText: { icon: ScrollText, words: 'policy charter' }, ShieldCheck: { icon: ShieldCheck, words: 'quality assurance compliance' }, BadgeCheck: { icon: BadgeCheck, words: 'quality accreditation' },
  Award: { icon: Award, words: 'quality excellence' }, Medal: { icon: Medal, words: 'achievement' }, Trophy: { icon: Trophy, words: 'achievement excellence' }, Star: { icon: Star, words: 'excellence' },
  Building2: { icon: Building2, words: 'institution organization' }, Building: { icon: Building, words: 'facilities' }, School: { icon: School, words: 'institution school' },
  House: { icon: House, words: 'housing campus' }, GraduationCap: { icon: GraduationCap, words: 'programs graduates degree' }, BookOpen: { icon: BookOpen, words: 'curriculum teaching learning' },
  BookOpenCheck: { icon: BookOpenCheck, words: 'learning assessment' }, Library: { icon: Library, words: 'library resources' }, NotebookPen: { icon: NotebookPen, words: 'course learning' },
  Presentation: { icon: Presentation, words: 'teaching' }, Users: { icon: Users, words: 'students faculty people' }, UsersRound: { icon: UsersRound, words: 'community people' },
  UserCheck: { icon: UserCheck, words: 'faculty staff' }, Briefcase: { icon: Briefcase, words: 'staff employment career' }, Handshake: { icon: Handshake, words: 'partnership engagement' },
  HeartHandshake: { icon: HeartHandshake, words: 'community service support' }, HandHeart: { icon: HandHeart, words: 'support wellbeing' }, Heart: { icon: Heart, words: 'wellbeing' },
  Smile: { icon: Smile, words: 'satisfaction experience' }, Stethoscope: { icon: Stethoscope, words: 'health' }, Accessibility: { icon: Accessibility, words: 'inclusion access' },
  ClipboardCheck: { icon: ClipboardCheck, words: 'assessment audit review' }, ClipboardList: { icon: ClipboardList, words: 'assessment checklist' }, ListChecks: { icon: ListChecks, words: 'outcomes criteria' },
  CircleCheck: { icon: CircleCheck, words: 'done approval' }, ListTree: { icon: ListTree, words: 'framework structure' }, FileText: { icon: FileText, words: 'document report' },
  Files: { icon: Files, words: 'documents records' }, FileStack: { icon: FileStack, words: 'documents evidence' }, FolderOpen: { icon: FolderOpen, words: 'evidence records' },
  Archive: { icon: Archive, words: 'records archive' }, ChartColumn: { icon: ChartColumn, words: 'data analytics kpi' }, ChartLine: { icon: ChartLine, words: 'trend performance' },
  ChartPie: { icon: ChartPie, words: 'data share' }, TrendingUp: { icon: TrendingUp, words: 'improvement performance' }, Gauge: { icon: Gauge, words: 'effectiveness performance kpi' },
  Activity: { icon: Activity, words: 'monitoring' }, RefreshCcw: { icon: RefreshCcw, words: 'continuous improvement cycle' }, Repeat: { icon: Repeat, words: 'cycle review' },
  Microscope: { icon: Microscope, words: 'research science' }, FlaskConical: { icon: FlaskConical, words: 'research lab' }, Atom: { icon: Atom, words: 'research science' },
  Brain: { icon: Brain, words: 'knowledge research' }, Sparkles: { icon: Sparkles, words: 'innovation ai' }, Bot: { icon: Bot, words: 'ai technology' },
  Globe: { icon: Globe, words: 'international global' }, Map: { icon: Map, words: 'region community' }, MapPin: { icon: MapPin, words: 'location campus' },
  Network: { icon: Network, words: 'partnerships network' }, Workflow: { icon: Workflow, words: 'process operations' }, GitBranch: { icon: GitBranch, words: 'process' },
  Layers: { icon: Layers, words: 'structure' }, LayoutGrid: { icon: LayoutGrid, words: 'overview' }, Puzzle: { icon: Puzzle, words: 'integration' }, Blocks: { icon: Blocks, words: 'structure' },
  Boxes: { icon: Boxes, words: 'resources' }, Settings2: { icon: Settings2, words: 'operations' }, Wrench: { icon: Wrench, words: 'maintenance infrastructure' },
  Cpu: { icon: Cpu, words: 'technology' }, Monitor: { icon: Monitor, words: 'technology it' }, Laptop: { icon: Laptop, words: 'technology elearning' }, Server: { icon: Server, words: 'infrastructure it' },
  Database: { icon: Database, words: 'data information' }, KeyRound: { icon: KeyRound, words: 'security access' }, Wallet: { icon: Wallet, words: 'finance budget' },
  Banknote: { icon: Banknote, words: 'finance resources' }, PiggyBank: { icon: PiggyBank, words: 'finance sustainability' }, Coins: { icon: Coins, words: 'finance' },
  Calendar: { icon: Calendar, words: 'schedule' }, CalendarCheck: { icon: CalendarCheck, words: 'planning schedule' }, Clock: { icon: Clock, words: 'time' }, Timer: { icon: Timer, words: 'time' },
  MessageSquare: { icon: MessageSquare, words: 'feedback communication' }, MessagesSquare: { icon: MessagesSquare, words: 'feedback stakeholders' }, Megaphone: { icon: Megaphone, words: 'communication outreach' },
  Mail: { icon: Mail, words: 'communication' }, Inbox: { icon: Inbox, words: 'requests' }, Languages: { icon: Languages, words: 'language' }, Leaf: { icon: Leaf, words: 'sustainability environment' },
  Sprout: { icon: Sprout, words: 'growth development' }, Recycle: { icon: Recycle, words: 'sustainability' }, Eye: { icon: Eye, words: 'transparency oversight' }, Search: { icon: Search, words: 'review audit' },
  Zap: { icon: Zap, words: 'energy' }, Bus: { icon: Bus, words: 'transport services' }, Utensils: { icon: Utensils, words: 'services dining' }, Dumbbell: { icon: Dumbbell, words: 'sports student life' },
  Music: { icon: Music, words: 'arts culture' }, Palette: { icon: Palette, words: 'arts design' }, PenTool: { icon: PenTool, words: 'design writing' },
};

/** A standard's icon, or its code in a small badge when it has none (or an unknown one). */
export function StandardIcon({ name, code, className = 'size-4' }: { name: string | null | undefined; code: string; className?: string }) {
  const found = name ? STANDARD_ICONS[name] : undefined;
  if (found) { const I = found.icon; return <I aria-hidden="true" className={`${className} shrink-0`} />; }
  return <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded border border-current font-mono text-[10px] leading-none">{code.slice(0, 3)}</span>;
}

/** Chooses one of the icons (search by name or meaning), or none. */
export function IconPicker({ title, value, onPick, onClose }: { title: string; value: string | null; onPick: (name: string | null) => Promise<unknown> | void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return Object.entries(STANDARD_ICONS).filter(([n, v]) => !s || n.toLowerCase().includes(s) || v.words.includes(s));
  }, [q]);
  const pick = async (name: string | null) => { setBusy(true); try { await onPick(name); onClose(); } finally { setBusy(false); } };
  return (
    <Dialog labelledBy="icon-picker-title" onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 id="icon-picker-title" className="min-w-0 pt-1 text-lg font-semibold break-words">{title}</h2>
        <Button type="button" variant="ghost" aria-label="Close" onClick={onClose}>✕</Button>
      </div>
      <Input aria-label="Search icons" placeholder="Search: mission, students, research…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div role="listbox" aria-label="Icons" className="mt-3 grid max-h-[50vh] grid-cols-6 gap-1 overflow-y-auto sm:grid-cols-8">
        {shown.map(([name, v]) => {
          const I = v.icon;
          return (
            <button key={name} type="button" role="option" aria-selected={value === name} aria-label={name} title={name} disabled={busy} onClick={() => void pick(name)}
              className={`flex aspect-square items-center justify-center rounded-md border hover:bg-muted ${value === name ? 'border-primary bg-muted' : 'border-transparent'}`}>
              <I aria-hidden="true" className="size-5" />
            </button>
          );
        })}
        {!shown.length && <p className="col-span-full text-sm text-muted-foreground">No icon matches.</p>}
      </div>
      <div className="mt-3 flex justify-between gap-2">
        <Button type="button" variant="ghost" disabled={busy || !value} onClick={() => void pick(null)}>No icon</Button>
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}

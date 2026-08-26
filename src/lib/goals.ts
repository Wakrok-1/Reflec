import { supabase } from './supabase'
import type { Goal } from './database.types'

// Big Life Goals, Increments, and the Bucket List (PRD 5.5) all live in the
// one `goals` table, distinguished by `type`. This module groups the flat
// rows into the shapes the Goals/Achievements pages actually render.

export interface GoalWithIncrements {
  goal: Goal
  increments: Goal[]
  progress: number
}

export interface GoalsData {
  bigGoals: GoalWithIncrements[]
  bucketList: Goal[]
  completedGoals: GoalWithIncrements[]
}

export function computeProgress(increments: Goal[]): number {
  if (increments.length === 0) return 0
  const done = increments.filter((i) => i.status === 'completed').length
  return Math.round((done / increments.length) * 100)
}

function groupIncrementsByParent(rows: Goal[]): Map<string, Goal[]> {
  const byParent = new Map<string, Goal[]>()
  for (const row of rows) {
    if (row.type !== 'increment' || !row.parent_goal_id) continue
    const list = byParent.get(row.parent_goal_id) ?? []
    list.push(row)
    byParent.set(row.parent_goal_id, list)
  }
  return byParent
}

export async function fetchGoalsData(userId: string): Promise<GoalsData> {
  const { data } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  const rows = data ?? []

  const incrementsByParent = groupIncrementsByParent(rows)
  const bigGoals: GoalWithIncrements[] = []
  const completedGoals: GoalWithIncrements[] = []

  for (const goal of rows) {
    if (goal.type !== 'big_goal') continue
    const increments = incrementsByParent.get(goal.id) ?? []
    const entry: GoalWithIncrements = { goal, increments, progress: computeProgress(increments) }
    if (goal.status === 'completed') completedGoals.push(entry)
    else bigGoals.push(entry)
  }

  const bucketList = rows.filter((g) => g.type === 'bucket_list' && g.status !== 'archived')

  return { bigGoals, bucketList, completedGoals }
}

export async function createBigGoal(
  userId: string,
  title: string,
  description: string | null,
  incrementTitles: string[],
) {
  const { data: goal } = await supabase
    .from('goals')
    .insert({ user_id: userId, type: 'big_goal', title, description })
    .select('*')
    .single()
  if (!goal) return null

  const titles = incrementTitles.map((t) => t.trim()).filter(Boolean)
  if (titles.length > 0) {
    await supabase
      .from('goals')
      .insert(titles.map((t) => ({ user_id: userId, type: 'increment' as const, parent_goal_id: goal.id, title: t })))
  }
  return goal
}

export async function addIncrement(userId: string, goalId: string, title: string) {
  await supabase.from('goals').insert({ user_id: userId, type: 'increment', parent_goal_id: goalId, title })
}

export async function toggleIncrement(incrementId: string, completed: boolean) {
  await supabase
    .from('goals')
    .update({ status: completed ? 'completed' : 'active', completed_at: completed ? new Date().toISOString() : null })
    .eq('id', incrementId)
}

export async function completeBigGoal(goalId: string) {
  await supabase
    .from('goals')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', goalId)
}

export async function updateGoalTitle(goalId: string, title: string) {
  await supabase.from('goals').update({ title }).eq('id', goalId)
}

export async function updateIncrementTitle(incrementId: string, title: string) {
  await supabase.from('goals').update({ title }).eq('id', incrementId)
}

export async function addBucketItem(userId: string, title: string, description: string | null = null) {
  await supabase.from('goals').insert({ user_id: userId, type: 'bucket_list', title, description })
}

export async function toggleBucketItem(id: string, completed: boolean) {
  await supabase
    .from('goals')
    .update({ status: completed ? 'completed' : 'active', completed_at: completed ? new Date().toISOString() : null })
    .eq('id', id)
}

import type React from 'react'
import { Check, ChevronLeft, ChevronRight, Columns3, RotateCcw } from 'lucide-react'
import type { ColumnState } from '@shared/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { columnDef, defaultColumns } from '@/lib/columns'
import { cn } from '@/lib/utils'

/**
 * Column visibility and ordering. Rendered as plain controls rather than menu items so a
 * row can carry both a toggle and its reorder arrows without the two fighting over the
 * click.
 */
export function ColumnMenu({
  columns,
  onChange
}: {
  columns: ColumnState[]
  onChange: (columns: ColumnState[]) => void
}): React.JSX.Element {
  const toggle = (id: string): void => {
    onChange(
      columns.map((column) =>
        column.id === id && !columnDef(column.id).fixed
          ? { ...column, visible: !column.visible }
          : column
      )
    )
  }

  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= columns.length) return
    const next = columns.slice()
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Columns"
          className="text-muted-foreground hover:text-foreground"
        >
          <Columns3 className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>

        {columns.map((column, index) => {
          const def = columnDef(column.id)
          return (
            <div
              key={column.id}
              className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-[12.5px] hover:bg-accent/60"
            >
              <button
                type="button"
                onClick={() => toggle(column.id)}
                disabled={def.fixed}
                className={cn(
                  'flex flex-1 items-center gap-2 rounded-sm px-1 py-0.5 text-left',
                  def.fixed && 'cursor-default opacity-60'
                )}
                title={def.fixed ? 'The name column is always shown' : `Toggle ${def.label}`}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {column.visible && <Check className="h-3.5 w-3.5" />}
                </span>
                {def.label}
              </button>

              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={`Move ${def.label} left`}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
              >
                <ChevronLeft className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === columns.length - 1}
                aria-label={`Move ${def.label} right`}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-25"
              >
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          )
        })}

        <DropdownMenuSeparator />
        <button
          type="button"
          onClick={() => onChange(defaultColumns())}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-[12.5px] hover:bg-accent"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset columns
        </button>
        <p className="px-2 pb-1 pt-1.5 text-[10.5px] leading-snug text-muted-foreground/60">
          Drag a header edge to resize. Double-click it to fit.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

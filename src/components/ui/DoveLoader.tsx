// Loading spinner — dove circling ring (design spec section 6). Used
// whenever an AI response is being generated or data is loading.
interface DoveLoaderProps {
  label?: string
}

export function DoveLoader({ label = 'Your Reflection is listening...' }: DoveLoaderProps) {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div className="dove-ring" />
      {label && <p className="font-poppins text-[11px] font-light italic text-warm-muted">{label}</p>}
    </div>
  )
}

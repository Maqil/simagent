# Operator traits (`+=` on your own types)

**Java/TS analogy:** Java and TS can't overload operators, so you'd write `total.add(u)`.
Rust lets a type opt in to `+`, `+=`, `==` and friends by implementing a trait from
`std::ops`. The operator is just sugar for a method call.

## Minimal example
```rust
use std::ops::AddAssign;

#[derive(Debug, Default, Clone, Copy)]
struct Tokens { input: u64, output: u64 }

// `total += &t` calls `total.add_assign(&t)`.
impl AddAssign<&Tokens> for Tokens {
    fn add_assign(&mut self, other: &Tokens) {
        self.input += other.input;
        self.output += other.output;
    }
}

fn main() {
    let mut total = Tokens::default();
    for t in [Tokens { input: 1, output: 2 }, Tokens { input: 3, output: 4 }] {
        total += &t;
    }
    assert_eq!(total.input, 4);
}
```

## Why it's used here
`Usage` (`crates/sim-core/src/event.rs`) and `CostBreakdown` (`crates/sim-core/src/cost.rs`)
are summed in many places: per agent now, and per hour, day, model and session for the
Usage page. With `AddAssign`, adding a field (like `cache_write_1h`) means updating one
`impl` instead of hunting down every place that sums four fields by hand.

## Details worth knowing
- `AddAssign<&Usage>` takes the right-hand side **by reference**, so summing never moves
  or copies the value you're adding. `Usage` is `Copy` anyway, but borrowing is the habit.
- `Add` (`a + b`, returns a new value) and `AddAssign` (`a += b`, mutates `a`) are separate
  traits. Accumulating totals only needs `AddAssign`.
- Only implement operators when the meaning is obvious. "Add two usage records" is; an
  operator with a surprising meaning makes code harder to read, not easier.

import { type HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  tick?: boolean;
};

export function Card({ tick, className = "", children, ...props }: Props) {
  return (
    <div className={`card ${tick ? "tick" : ""} ${className}`} {...props}>
      {children}
    </div>
  );
}

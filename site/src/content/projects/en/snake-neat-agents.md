---
title: Self-learning Snake agents
summary: >-
  Snake rebuilt from scratch so every rule was controllable, then NEAT agents that
  evolve their own neural networks to play it.
category: data-ai
tech:
  - Python
  - Pygame
  - NEAT
date: 2022-10-27
status: archived
links:
  repo: https://github.com/moncef-bousselat/snake_neat_ai
---

Writing my own Snake first was the point: controlling every rule and every tick
is what made it usable as a training environment.

On top of it sit agents trained with NEAT — Neuro-Evolution of Augmenting
Topologies — which grows networks rather than training a fixed one. It starts
from minimal neural networks and mutates and recombines them across
generations, so the topology itself evolves alongside the weights.

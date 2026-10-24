---
title: Kubernetes fault tolerance and autoscaling
summary: >-
  A containerised Python service under Kubernetes HPA, stress-tested to verify it
  scales and self-heals — 99% availability, with Prometheus recording the behaviour.
category: cloud
tech:
  - Kubernetes
  - Docker
  - Prometheus
  - Python
  - Bash
date: 2025-03-16
status: completed
featured: true
links:
  repo: https://github.com/moncef-bousselat/kubernetes-fault-tolerance
---

A Python application on Docker containers, orchestrated by Kubernetes with a
Horizontal Pod Autoscaler targeting 30% CPU utilisation.

The interesting part is the testing rather than the deployment. Stress tests
driven by concurrent cURL loops pushed the cluster hard enough to trigger both
behaviours worth proving: scaling out under load, and replacing pods that were
killed mid-request. The system held 99% availability across those runs.

Prometheus scraped resource utilisation throughout, which is what turns
"it seemed to recover" into a number.

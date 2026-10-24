# Offline GPS quality experiments

These modules are replay/test tools, not application location filters. They were moved out of src after the release decision to exclude unvalidated automatic jitter removal. Application source must not import this directory.

Preserve original samples when replaying. A suspected point is not permission to delete it. Unknown, absent or unreliable motion evidence cannot certify stillness. Results on simulated loops and the available device sessions do not guarantee safety on all movement.

Private coordinate fixtures and credentials remain in the ignored .amplify/incident-104 directory; do not add them here. Native diagnostic cleanup is tracked separately, without dropping existing receipt/control databases.

Native sensor source snapshots and historical harnesses are in native/. They are not compiled into the app. The collector harness describes the previous diagnostic build and requires separate compilation of that fixture; do not validate it against production Gradle outputs. Receipt compatibility remains covered by the production SQL and Native tests.

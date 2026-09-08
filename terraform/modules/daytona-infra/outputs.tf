output "snapshot_build_id" {
  description = "ID of the snapshot build resource (for depends_on references)"
  value       = null_resource.daytona_snapshot.id
}

output "snapshot_name" {
  description = "Immutable snapshot name published by this build"
  value       = local.snapshot_name
}

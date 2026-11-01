"""Select whether a release must rebuild the guest and KVM image matrix."""
import os
from pathlib import Path
import re
import subprocess


RELEASE_TAG = re.compile(r"^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:\.([0-9]+))?$")
IMAGE_PATHS = ("docker/kin-os", "docker/kin-kvm", ".github/workflows/guest-images.yml")


def git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def release_tag_key(tag):
    match = RELEASE_TAG.fullmatch(tag)
    if not match:
        return None
    return tuple(int(part or 0) for part in match.groups())


def latest_release_tag(repo):
    tags = []
    repository = os.environ.get("GITHUB_REPOSITORY")
    if repository:
        try:
            output = subprocess.check_output(
                [
                    "gh",
                    "release",
                    "list",
                    "--repo",
                    repository,
                    "--limit",
                    "100",
                    "--json",
                    "tagName,isDraft",
                    "--jq",
                    '.[] | select(.isDraft == false) | .tagName',
                ],
                cwd=repo,
                text=True,
                stderr=subprocess.DEVNULL,
            )
            tags = output.splitlines()
        except (OSError, subprocess.CalledProcessError):
            pass
    if not tags:
        tags = git(repo, "tag", "--list", "v[0-9]*").splitlines()
    candidates = [(release_tag_key(tag), tag) for tag in tags]
    candidates = [(key, tag) for key, tag in candidates if key is not None]
    return max(candidates, default=(None, None))[1]


def release_source(repo, tag):
    if not tag:
        return None
    commit = git(repo, "rev-list", "-n", "1", tag)
    version = git(repo, "show", f"{commit}:VERSION")
    parents = git(repo, "show", "-s", "--format=%P", commit).split()
    if len(version.split(".")) == 4 and len(parents) == 1:
        return parents[0]
    return commit


def image_paths_changed(repo, base, head="HEAD"):
    if not base:
        return False
    result = subprocess.run(
        ["git", "diff", "--quiet", base, head, "--", *IMAGE_PATHS],
        cwd=repo,
    )
    return result.returncode == 1


def decision(repo, *, event_name, publish, upstream_version, rebuild_requested, head="HEAD"):
    if publish != "true":
        return False, "publish=false; guest/KVM images are not published."
    if event_name == "push":
        return True, "Automatic upstream release; rebuild the complete guest/KVM image matrix."
    if upstream_version == "true":
        return True, "Manual upstream-version release; rebuild the complete guest/KVM image matrix."
    if rebuild_requested == "true":
        return True, "Manual rebuild requested; rebuild the complete guest/KVM image matrix."
    tag = latest_release_tag(repo)
    base = release_source(repo, tag)
    if image_paths_changed(repo, base, head):
        return True, f"Guest/KVM sources changed since {tag or 'the first release'}; rebuild the image matrix."
    return False, f"No guest/KVM source changes since {tag or 'the first release'}; reuse existing slot images."


def main():
    repo = Path.cwd()
    result, reason = decision(
        repo,
        event_name=os.environ.get("GITHUB_EVENT_NAME", ""),
        publish=os.environ.get("PUBLISH", "false"),
        upstream_version=os.environ.get("UPSTREAM_VERSION", "false"),
        rebuild_requested=os.environ.get("REBUILD_GUEST_IMAGES", "false"),
        head=os.environ.get("GITHUB_SHA", "HEAD"),
    )
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a") as output:
            output.write(f"rebuild={str(result).lower()}\n")
            output.write(f"reason={reason}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as output:
            output.write(f"## Guest/KVM image policy\n\n{reason}\n")
    print(reason)


if __name__ == "__main__":
    main()

class Agentdx < Formula
  desc "Local-first tool to see what your AI coding agents are actually doing"
  homepage "https://www.npmjs.com/package/@agentdx/agentdx"
  url "https://registry.npmjs.org/@agentdx/agentdx/-/agentdx-#{version}.tgz"
  version "0.2.9"
  sha256 "a98fb66c20f903fd63b47b03b34363974c6ae1d4801d6135f64974e56600872c"
  license "MIT"

  depends_on "node" => ">= 18"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agentdx --version")
  end
end

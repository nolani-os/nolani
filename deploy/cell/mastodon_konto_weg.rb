# Remove the Mastodon account(s) of a ClaraOS user — via `rails runner`:
#   docker compose exec -T mastodon-web bin/rails runner "$(cat mastodon_konto_weg.rb)" <username>
#
# Found by the OIDC identity (uid = ClaraOS user name), not by the Mastodon user name:
# Mastodon strips everything but [a-z0-9_] and appends _1, _2 … when a name is taken.
# The user name is NOT reserved afterwards, so the next login gets the plain name again.
uid = ARGV.first.to_s
abort "no user name" if uid.empty?
Identity.where(provider: "openid_connect", uid: uid).includes(user: :account).find_each do |identity|
  account = identity.user&.account
  next unless account
  DeleteAccountService.new.call(account, reserve_email: false, reserve_username: false)
  puts "MASTODON_GELOESCHT #{account.username}"
end

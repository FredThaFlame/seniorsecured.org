# Pointing seniorsecured.org at the new site

**For: Fred — Time needed: about 10 minutes, plus waiting**

Your website is built and running. The only thing left is telling the internet
where to find it.

Right now `seniorsecured.org` shows a Namecheap "parking" page — the placeholder
you get with a new domain. We need to replace that with directions to where the
real site lives. That's what the steps below do.

Nothing here can break your domain permanently. Every change is reversible.

---

## Before you start

- You'll need your **Namecheap** login (the account that owns the domain).
- **If you use email at `@seniorsecured.org`, read the warning in Step 4.**
  There is exactly one way to cause real trouble here and that's it.
- Once you save, the site may be briefly unreachable while the change spreads
  across the internet. This is normal and usually takes a few minutes.

---

## Step 1 — Sign in and find the domain

1. Go to **[namecheap.com](https://www.namecheap.com)** and sign in.
2. In the left sidebar, click **Domain List**.
3. Find `seniorsecured.org` in the list and click the **MANAGE** button on its
   right-hand side.

## Step 2 — Open the DNS settings

At the top of the page you'll see a row of tabs: *Domain*, *Products*,
*Sharing & Transfer*, **Advanced DNS**.

Click **Advanced DNS**.

You should now see a section called **Host Records** with a few rows in it.

## Step 3 — Take a photo of the screen

Seriously — take a screenshot or a phone photo of the Host Records section
before changing anything. If something goes sideways, that picture is how we
put it back in thirty seconds.

## Step 4 — Delete the two parking records

You're looking for exactly **two** rows, and you'll delete each by clicking the
**trash bin icon** on its right-hand side.

**Delete these two:**

| Type | Host | Value |
|---|---|---|
| A Record | `@` | `192.64.119.199` |
| CNAME Record | `www` | `parkingpage.namecheap.com.` |

You may also see a row called **URL Redirect Record** pointing at
`www.seniorsecured.org` — delete that one too if it's there.

> ### ⚠️ Do not delete anything else
>
> If you see rows of type **MX**, **TXT**, or anything mentioning
> `mail`, `mx`, `spf`, `dkim`, or `google` — **leave them exactly as they
> are.** Those run your email. Deleting them stops mail reaching you, and
> that's the one mistake here that actually hurts.
>
> Only the two rows in the table above should go.

## Step 5 — Add the five new records

Click **ADD NEW RECORD** and add each row below, one at a time. There are five.

For the first four, choose **A Record** from the Type dropdown:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `@` | `185.199.108.153` | Automatic |
| A Record | `@` | `185.199.109.153` | Automatic |
| A Record | `@` | `185.199.110.153` | Automatic |
| A Record | `@` | `185.199.111.153` | Automatic |

Then one more, choosing **CNAME Record** from the dropdown:

| Type | Host | Value | TTL |
|---|---|---|---|
| CNAME Record | `www` | `FredThaFlame.github.io.` | Automatic |

**Three things people get wrong here:**

- The Host for the four A records is the single character **`@`**. Not your
  domain name, not `www`. Just `@`. It means "the domain itself."
- Yes, all four A records really do use the same `@`. That's correct — four
  addresses for the same destination, so the site stays up if one is down.
- The CNAME value ends with a **dot**: `FredThaFlame.github.io.` Namecheap
  usually adds it for you. If it doesn't, type it.

## Step 6 — Save

Click the green **✓ SAVE ALL CHANGES** button.

When you're done, Host Records should contain your five new rows, plus any
email rows you correctly left alone. The parking rows should be gone.

---

## Step 7 — Wait, then check

Give it **5 to 30 minutes**. Occasionally it takes a few hours — that's the
internet updating its address books, and nothing you can speed up.

Then visit **[https://seniorsecured.org](https://seniorsecured.org)**.

**Success looks like:** your site — the cream-coloured page with your name and
photo on the left. If there are no articles yet, it will say *"No posts yet"*.
That is correct and expected; it means everything is working and it's waiting
for you to write.

**If you still see the parking page:** your browser or computer may be
remembering the old address. Try again in a private/incognito window, or on
your phone using mobile data instead of wifi. If it's still the parking page
after a few hours, send a screenshot of your Host Records and we'll sort it.

---

## One last step, on the other side

Once the site loads, there's a checkbox on GitHub — **Enforce HTTPS** — that
turns on the padlock in the address bar. It can't be ticked until the security
certificate is issued, which only happens after the steps above are done and
have spread.

**Tell your manager the site is loading, and they'll finish that part.** It
takes them about ten seconds.

---

## Quick reference

Everything above, condensed:

**Delete:** `A @ 192.64.119.199` and `CNAME www parkingpage.namecheap.com.`
(and any URL Redirect Record). **Keep all MX and TXT records.**

**Add:**

```
A       @     185.199.108.153
A       @     185.199.109.153
A       @     185.199.110.153
A       @     185.199.111.153
CNAME   www   FredThaFlame.github.io.
```

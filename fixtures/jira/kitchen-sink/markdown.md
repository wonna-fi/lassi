## Login page throws 500 on empty password

**Steps to reproduce**

1. Open [the login page](https://app.example.internal/login)
2. Leave the password empty
3. Click **Sign in**

**Actual**: HTTP 500, see ![stack.png](attachment:stack.png "thumbnail") and the log:

```text
NullPointerException at Login.validate(Login.java:42)
```

**Expected**: a validation message. Related: @jsmith said in PROJ-12 that `dto.password` is optional.

| Env | Result |
| - | - |
| prod | 500 |
| staging | works |

> Regression from the 2.3.0 release.

---

(x) not fixed yet

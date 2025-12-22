function Test() {
  return (
    <>
      <div className="navbar bg-base-100 shadow-sm px-7">
        <div className="flex-1">
          <button className="btn btn-ghost text-xl bric">Theo.ai</button>
          <button className="inter text-xs ">
            Partial Blindess Accessibility Agent
          </button>
        </div>

        <div className="flex-none">
          {/* Open the modal using document.getElementById('ID').showModal() method */}
          <button
            className="btn"
            onClick={() => document.getElementById("my_modal_1").showModal()}
          >
            <i class="bi bi-gear-fill"></i> Settings
          </button>
          <dialog id="my_modal_1" className="modal text-black">
            <div className="modal-box ">
              <h3 className="font-bold text-lg">This is a test popup.</h3>
              <p className="py-4">
                Press ESC key or click the button below to close
              </p>
              <div className="modal-action">
                <form method="dialog">
                  {/* if there is a button in form, it will close the modal */}
                  <button className="btn">Close</button>
                </form>
              </div>
            </div>
          </dialog>
        </div>
      </div>
    </>
  );
}

export default Test;
